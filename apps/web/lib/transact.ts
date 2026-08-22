import "server-only";
import {
  LlmRevenueAgent,
  ScriptedRevenueAgent,
  type NegotiatorContext,
  gateVia,
  personaFor,
} from "@mercury/agent";
import { type Proposal, type RuleEval, newId } from "@mercury/core";
import { TEST_VPA_FAILURE, TEST_VPA_SUCCESS } from "@mercury/rail";
import { mercury } from "./mercury";
import { envelopeView } from "./run";
import type { EnvelopeView } from "./types";

/**
 * The buyer-facing transaction path.
 *
 * This is what an external agent reaches through MCP. Note what it does *not*
 * accept: a price, a total, a discount, or a cart the buyer priced itself. A
 * buyer sends a sentence and a mandate id. The merchant's own agent proposes,
 * Dwaar disposes, and the buyer is told what happened.
 *
 * That asymmetry is the point. An outside model driving this API cannot name
 * an amount, so no amount it hallucinates can ever be charged.
 */

export interface QuoteLine {
  sku: string;
  title: string;
  qty: number;
  unit_paise: number;
  list_paise: number;
  line_total_paise: number;
}

export interface QuoteResult {
  session_id: string;
  outcome: "ALLOW" | "ALLOW_WITH_STEPUP" | "DENY";
  merchant: { merchant_id: string; display_name: string; vertical: string };
  reply: string;
  /** Present when the gate allowed the cart. */
  cart?: {
    lines: QuoteLine[];
    total_paise: number;
    order_id: string;
    intent_token_id: string;
    expires_at: string;
  };
  /** Present when a human must approve before the money moves. */
  step_up?: { reason: string; approval_url: string };
  /** Every rule Dwaar evaluated, with the observed value and the limit. */
  rules: RuleEval[];
  /** Rounds the merchant agent needed. More than one means the gate pushed back. */
  rounds: number;
  envelope: EnvelopeView | undefined;
  /** Where in the ledger this negotiation is recorded. */
  ledger_seq: number;
}

export class TransactError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TransactError";
    this.status = status;
  }
}

export async function quote(input: {
  merchant_id: string;
  mandate_id: string;
  message: string;
  mode?: "scripted" | "llm";
}): Promise<QuoteResult> {
  const m = mercury();

  const profile = m.store.getMerchant(input.merchant_id);
  if (profile === undefined) {
    throw new TransactError(`no such merchant: ${input.merchant_id}`, 404);
  }
  if (m.store.getMandate(input.mandate_id) === undefined) {
    throw new TransactError(`no such mandate: ${input.mandate_id}`, 404);
  }

  const sessionId = newId("session");
  const catalog = m.store.catalogFor(profile.merchant_id);
  const bridge = gateVia(m.engine, {
    mandate_id: input.mandate_id,
    session_id: sessionId,
  });

  let lastRules: RuleEval[] = [];
  const ctx: NegotiatorContext = {
    profile,
    catalog,
    persona: personaFor(profile.vertical),
    maxRounds: 3,
    submit: async (proposal: Proposal) => {
      const before = bridge.results().length;
      const feedback = await bridge.submit(proposal);
      lastRules = bridge.results()[before]?.decision.rules ?? [];
      return feedback;
    },
  };

  const agent =
    input.mode === "llm"
      ? new LlmRevenueAgent(ctx)
      : new ScriptedRevenueAgent(ctx, {});

  const result = await agent.negotiate({
    session_id: sessionId,
    buyer_message: input.message,
  });

  const accepted = bridge.accepted();
  const base = {
    session_id: sessionId,
    merchant: {
      merchant_id: profile.merchant_id,
      display_name: profile.display_name,
      vertical: profile.vertical,
    },
    reply: result.reply,
    rules: lastRules,
    rounds: result.rounds.length,
    envelope: envelopeView(input.mandate_id),
    ledger_seq: m.sakshi.count(),
  };

  if (accepted === undefined || accepted.kind === "DENIED") {
    return { ...base, outcome: "DENY" };
  }

  const cart = {
    lines: accepted.cart.lines.map((l) => ({
      sku: l.sku,
      title: catalog.get(l.sku)?.title ?? l.sku,
      qty: l.qty,
      unit_paise: l.unit_paise,
      list_paise: l.list_paise,
      line_total_paise: l.line_total_paise,
    })),
    total_paise: accepted.decision.computed_paise,
    order_id: accepted.order_id,
    intent_token_id: accepted.token.token_id,
    expires_at: accepted.token.expires_at,
  };

  if (accepted.kind === "STEP_UP_REQUIRED") {
    return {
      ...base,
      outcome: "ALLOW_WITH_STEPUP",
      cart,
      step_up: { reason: accepted.decision.step_up, approval_url: accepted.link_url },
    };
  }

  return { ...base, outcome: "ALLOW", cart };
}

export interface PayResult {
  status: "captured" | "approval_required" | "rejected";
  payment_id?: string;
  amount_paise?: number;
  attempts?: number;
  approval_url?: string;
  reason?: string;
  envelope: EnvelopeView | undefined;
  ledger_seq: number;
}

/**
 * Redeem an intent token.
 *
 * The token is spent before the payment is attempted, so a replay is rejected
 * even if it arrives while the first attempt is still in flight.
 */
export async function pay(input: {
  order_id: string;
  intent_token_id: string;
  /**
   * The session the quote ran under. Threading it through means the whole
   * transaction -- offer, decision, order, capture -- lands in the ledger under
   * one id, so a buyer can read back its own purchase in a single query. A new
   * id would still be recorded, just orphaned from the negotiation that caused it.
   */
  session_id?: string;
  /** Fixture only: use the failing test VPA to exercise the decline path. */
  simulate_failure?: boolean;
}): Promise<PayResult> {
  const m = mercury();
  const order = m.store.getOrder(input.order_id);
  if (order === undefined) throw new TransactError(`no such order: ${input.order_id}`, 404);

  const sessionId = input.session_id ?? newId("session");
  const fixture = m.fixture;
  if (fixture === undefined) {
    throw new TransactError(
      "live rail: the buyer completes payment in Razorpay Checkout, not through this API",
      409,
    );
  }

  const outcome = await m.engine.settle({
    order_id: input.order_id,
    token_id: input.intent_token_id,
    session_id: sessionId,
    vpa: input.simulate_failure === true ? TEST_VPA_FAILURE : TEST_VPA_SUCCESS,
    simulate: async (id, vpa) => {
      const sim = await fixture.simulateCheckout(id, vpa);
      return {
        paymentId: sim.payment.id,
        signature: sim.signature,
        failed: sim.payment.status === "failed",
      };
    },
  });

  const tail = { envelope: envelopeView(order.mandate_id), ledger_seq: m.sakshi.count() };

  switch (outcome.kind) {
    case "CAPTURED":
      return {
        status: "captured",
        payment_id: outcome.payment_id,
        amount_paise: outcome.amount,
        ...tail,
      };
    case "FAILED_FALLBACK_LINK":
      return {
        status: "approval_required",
        attempts: outcome.attempts,
        approval_url: outcome.link_url,
        reason: "automated retries exhausted; a human must approve this payment",
        ...tail,
      };
    case "REFUNDED":
      return { status: "rejected", reason: `refunded: ${outcome.reason}`, ...tail };
    default:
      return { status: "rejected", reason: outcome.reason, ...tail };
  }
}
