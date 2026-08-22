import type { Proposal, RuleId } from "@mercury/core";
import { formatINR, paise } from "@mercury/core";
import type {
  Negotiator,
  NegotiationResult,
  NegotiationRound,
  NegotiationTurn,
  NegotiatorContext,
} from "./negotiator.js";
import { priceFloor, quoteTotal, searchCatalog } from "./tools.js";

/**
 * The Revenue Agent without the model.
 *
 * `FixtureRail` is to Razorpay what this is to Claude (D10): the same interface,
 * a deterministic implementation, and the default everywhere correctness is
 * being asserted. Every test and all seven engineered failures run against this
 * agent, so the suite needs no API key, no network and no spend, and a run that
 * passes once passes identically forever.
 *
 * It is not a mock of the *system* -- it calls the same `searchCatalog` and
 * `priceFloor` implementations the model calls, submits a real `Proposal`
 * through the real gate, and re-quotes on a real denial. Only the judgement is
 * substituted.
 */

export interface ScriptedOptions {
  /** Discount to offer off list, in basis points. */
  discountBps?: number;
  /**
   * Offer this many paise per unit *below* the merchant's floor on the first
   * round -- an agent that caved to buyer pressure. This is the F1 injection.
   */
  underCutPaise?: number;
  /**
   * Add this to the quoted total without changing the lines: the agent's
   * arithmetic disagreeing with Dwaar's. Always a hard DENY on drift.
   */
  driftPaise?: number;
  /** What to buy. Omit to infer the cart from the buyer's message. */
  want?: readonly { sku: string; qty: number }[];
  /** Re-quote at the lowest legal price after a repairable denial. */
  reQuote?: boolean;
}

/** Infer a cart from free text: exact SKU mentions first, then title-word matches. */
export function inferCart(
  ctx: NegotiatorContext,
  message: string,
): { sku: string; qty: number }[] {
  const text = message.toLowerCase();
  const wanted: { sku: string; qty: number }[] = [];

  for (const item of searchCatalog(ctx, {})) {
    const bySku = text.includes(item.sku.toLowerCase());
    const words = item.title
      .toLowerCase()
      .split(/[^a-z]+/u)
      .filter((w) => w.length >= 4);
    const byTitle = words.some((w) => text.includes(w));
    if (!bySku && !byTitle) continue;

    // "10 sacks of rice" / "rice x 4" -- take the nearest number, else the MOQ.
    const qty = nearestQty(text, words[0] ?? item.sku.toLowerCase()) ?? item.moq;
    wanted.push({ sku: item.sku, qty: Math.max(qty, item.moq) });
  }
  return wanted;
}

function nearestQty(text: string, near: string): number | undefined {
  const at = text.indexOf(near);
  if (at < 0) return undefined;
  const window = text.slice(Math.max(0, at - 24), at + near.length + 12);
  const m = /(\d{1,4})/u.exec(window);
  if (m?.[1] === undefined) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) && n > 0 && n <= 5_000 ? n : undefined;
}

/**
 * What the merchant says when the gate refuses.
 *
 * A rule id is an operator's fact, not a sentence to read out to a customer.
 * The verdict panel and the ledger both carry the exact rule, the observed
 * value and the limit; the buyer gets a plain reason. These are fixed strings,
 * so nothing a model writes can end up standing in for a policy decision.
 */
const DECLINE_DEFAULT = "I cannot complete that. Let me know if you want a smaller basket.";

const DECLINE: Partial<Record<RuleId, string>> = {
  "MARGIN.FLOOR_BREACH":
    "That is below what we can sell it for. The price I quoted is the lowest we can do.",
  "DISCOUNT.BPS_CAP": "That discount is deeper than we are allowed to go on this line.",
  "DRIFT.AMOUNT_MISMATCH":
    "My total did not match the priced cart, so the offer was rejected before it could be charged. Nothing was taken.",
  "MANDATE.PER_TXN_CAP":
    "That basket is larger than a single transaction on your budget allows. Split it, or ask your human to raise the cap.",
  "MANDATE.ENVELOPE_REMAINING":
    "That exceeds what is left in your budget for this period.",
  "MANDATE.VELOCITY": "Your budget has no orders left in it for this period.",
  "MANDATE.EXPIRY": "Your budget authorisation has expired. Your human needs to issue a new one.",
  "MANDATE.SIGNATURE": "I could not verify your budget authorisation, so I cannot transact.",
  "INVENTORY.INSUFFICIENT": "Another buyer took the last of that stock while we were talking.",
  "CATALOG.UNKNOWN_SKU": "We do not stock that.",
  "CATALOG.BELOW_MOQ": "That is below the minimum order quantity for this line.",
  "SCOPE.MERCHANT_ALLOWLIST": "Your budget is not scoped to buy from us.",
  "SCOPE.CATEGORY_ALLOWLIST": "Your budget is not scoped to that category.",
  "TOKEN.REPLAY": "That authorisation has already been used.",
  "CIRCUIT.FROZEN": "Spending is frozen on our side right now. Nothing can be charged.",
};

export class ScriptedRevenueAgent implements Negotiator {
  readonly mode = "scripted" as const;
  readonly #ctx: NegotiatorContext;
  readonly #opts: ScriptedOptions;

  constructor(ctx: NegotiatorContext, opts: ScriptedOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
  }

  async negotiate(turn: NegotiationTurn): Promise<NegotiationResult> {
    const maxRounds = this.#ctx.maxRounds ?? 3;
    const want = this.#opts.want ?? inferCart(this.#ctx, turn.buyer_message);
    const rounds: NegotiationRound[] = [];

    if (want.length === 0) {
      return {
        reply: "We do not stock anything matching that. Tell me a category and I will quote.",
        rounds,
      };
    }

    let proposal = this.#firstOffer(want);
    let settled: NegotiationRound | undefined;

    for (let round = 0; round < maxRounds; round += 1) {
      const feedback = await this.#ctx.submit(proposal);
      const entry: NegotiationRound = { proposal, feedback };
      rounds.push(entry);

      if (feedback.outcome !== "DENY") {
        settled = entry;
        break;
      }
      if (this.#opts.reQuote === false) break;

      const repaired = this.#reQuote(proposal);
      if (repaired === undefined) break;
      proposal = repaired;
    }

    return {
      reply: this.#reply(settled, rounds),
      rounds,
      ...(settled === undefined ? {} : { settled }),
    };
  }

  /** List price less the configured discount, floored at (or deliberately under) the merchant floor. */
  #firstOffer(want: readonly { sku: string; qty: number }[]): Proposal {
    const floors = new Map(priceFloor(this.#ctx, want.map((w) => w.sku)).map((f) => [f.sku, f]));
    const discountBps = this.#opts.discountBps ?? 500;
    const underCut = this.#opts.underCutPaise ?? 0;

    const lines = want.flatMap((w) => {
      const floor = floors.get(w.sku);
      if (floor === undefined) return [];
      const discounted = floor.list_paise - Math.floor((floor.list_paise * discountBps) / 10_000);
      const unit =
        underCut > 0
          ? Math.max(0, floor.lowest_legal_unit_paise - underCut)
          : Math.max(discounted, floor.lowest_legal_unit_paise);
      return [{ sku: w.sku, qty: w.qty, offer_unit_paise: paise(unit) }];
    });

    return {
      merchant_id: this.#ctx.profile.merchant_id,
      lines,
      quoted_total_paise: paise(quoteTotal(lines) + (this.#opts.driftPaise ?? 0)),
      rationale:
        underCut > 0
          ? "Matching the price the buyer pushed for."
          : `Standard basket at ${discountBps / 100}% off list.`,
    };
  }

  /** Clamp every line up to the lowest price the merchant will legally accept. */
  #reQuote(previous: Proposal): Proposal | undefined {
    const floors = new Map(
      priceFloor(this.#ctx, previous.lines.map((l) => l.sku)).map((f) => [f.sku, f]),
    );
    let moved = false;
    const lines = previous.lines.map((l) => {
      const floor = floors.get(l.sku);
      if (floor === undefined) return l;
      if (l.offer_unit_paise >= floor.lowest_legal_unit_paise) return l;
      moved = true;
      return { ...l, offer_unit_paise: paise(floor.lowest_legal_unit_paise) };
    });

    const honestTotal = paise(quoteTotal(lines));
    const drifted = previous.quoted_total_paise !== paise(quoteTotal(previous.lines));
    if (!moved && !drifted) return undefined;

    return {
      merchant_id: previous.merchant_id,
      lines,
      quoted_total_paise: honestTotal,
      rationale: "Re-quoted at the lowest price we can legally accept.",
    };
  }

  #reply(settled: NegotiationRound | undefined, rounds: readonly NegotiationRound[]): string {
    if (settled === undefined) {
      const rule = rounds.at(-1)?.feedback.rule_ids[0];
      return DECLINE[rule ?? "MARGIN.FLOOR_BREACH"] ?? DECLINE_DEFAULT;
    }
    const total = settled.feedback.computed_total_paise ?? settled.proposal.quoted_total_paise;
    const items = settled.proposal.lines.map((l) => `${l.qty} x ${l.sku}`).join(", ");
    const stepUp = settled.feedback.outcome === "ALLOW_WITH_STEPUP";
    return (
      `${items} comes to ${formatINR(paise(total))}. ` +
      (stepUp
        ? "That is above your approval threshold, so I have sent an approval link to your human."
        : "Confirmed and ready to pay.")
    );
  }
}

/** The counterparty, without the model: a fixed adversarial script. */
export class ScriptedBuyerAgent {
  readonly #lines: readonly string[];
  #at = 0;

  constructor(lines: readonly string[]) {
    this.#lines = lines;
  }

  async respond(): Promise<string> {
    const line = this.#lines[Math.min(this.#at, this.#lines.length - 1)] ?? "";
    this.#at += 1;
    return line;
  }
}
