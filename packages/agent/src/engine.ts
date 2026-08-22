import {
  type Decision,
  type IntentToken,
  type Paise,
  type PricedCart,
  type Proposal,
  type RuleId,
  hashValue,
  newId,
  newNonce,
  paise,
  receiptFor,
} from "@mercury/core";
import { type DwaarInput, cartHash, evaluate, repairProposal } from "@mercury/dwaar";
import { type EventType, Sakshi } from "@mercury/sakshi";
import { Store } from "@mercury/store";
import {
  type RazorpayPort,
  type WebhookVerdict,
  TEST_VPA_SUCCESS,
  WebhookGate,
} from "@mercury/rail";

/**
 * The engine: the only place where a decision becomes an effect.
 *
 * Dwaar decides, Sakshi records, the rail settles -- and this class is the
 * conductor that calls them in the right order. It contains no policy of its
 * own: every allow/deny in here came out of `evaluate()`.
 *
 * Deliberately free of any LLM. The whole settlement path, including all seven
 * engineered failures, runs deterministically with no API key and no network.
 * The Revenue Agent sits *above* this, and only ever supplies a Proposal.
 */

export interface EngineDeps {
  store: Store;
  sakshi: Sakshi;
  rail: RazorpayPort;
  /** Injected for determinism in tests and the demo. */
  now?: () => Date;
  /** How long an intent token is valid. */
  tokenTtlMs?: number;
  /** Bounded retry budget for a declined payment (F2). */
  maxPaymentRetries?: number;
}

export interface ProposeInput {
  mandate_id: string;
  proposal: Proposal;
  session_id: string;
  /** Attempt repair-and-retry once if the gate denies on a repairable rule. */
  autoRepair?: boolean;
  llm?: { model: string; effort: string; input_hash: string; output_hash: string };
}

export type ProposeResult =
  | {
      kind: "AUTHORISED";
      decision: Extract<Decision, { outcome: "ALLOW" }>;
      token: IntentToken;
      cart: PricedCart;
      order_id: string;
      repaired: boolean;
      adjustments: string[];
    }
  | {
      kind: "STEP_UP_REQUIRED";
      decision: Extract<Decision, { outcome: "ALLOW_WITH_STEPUP" }>;
      token: IntentToken;
      cart: PricedCart;
      order_id: string;
      link_url: string;
      repaired: boolean;
      adjustments: string[];
    }
  | { kind: "DENIED"; decision: Extract<Decision, { outcome: "DENY" }>; rule_id: RuleId };

export type SettleResult =
  | { kind: "CAPTURED"; payment_id: string; amount: Paise; consumed_paise: Paise }
  | { kind: "FAILED_FALLBACK_LINK"; attempts: number; link_url: string }
  | { kind: "REFUNDED"; refund_id: string; reason: string }
  | { kind: "REJECTED"; reason: string; rule_id?: RuleId };

/** Rules for which auto-repair can plausibly produce a legal proposal. */
const REPAIRABLE: ReadonlySet<RuleId> = new Set<RuleId>([
  "MARGIN.FLOOR_BREACH",
  "DISCOUNT.BPS_CAP",
]);

export class Engine {
  readonly #store: Store;
  readonly #sakshi: Sakshi;
  readonly #rail: RazorpayPort;
  readonly #now: () => Date;
  readonly #tokenTtlMs: number;
  readonly #maxRetries: number;
  readonly #gate: WebhookGate;

  constructor(deps: EngineDeps) {
    this.#store = deps.store;
    this.#sakshi = deps.sakshi;
    this.#rail = deps.rail;
    this.#now = deps.now ?? (() => new Date());
    this.#tokenTtlMs = deps.tokenTtlMs ?? 5 * 60_000;
    this.#maxRetries = deps.maxPaymentRetries ?? 2;
    this.#gate = new WebhookGate(this.#rail, {
      has: (id) => this.#store.hasSeenEvent(id),
      add: (id) => this.#store.markEventSeen(id),
    });
  }

  /* ------------------------------------------------------------------ log */

  #log(
    event_type: EventType,
    body: Omit<Parameters<Sakshi["append"]>[0], "event_type" | "actor"> & {
      actor?: Parameters<Sakshi["append"]>[0]["actor"];
    },
  ): number {
    const { actor, ...rest } = body;
    return this.#sakshi.append({
      actor: actor ?? { type: "dwaar", id: "dwaar" },
      event_type,
      ts: this.#now().toISOString(),
      ...rest,
    }).seq;
  }

  /* -------------------------------------------------------------- propose */

  /**
   * Take a proposal through the gate. On a repairable denial, clamp the offer
   * to the lowest legal price and re-evaluate once (F1) -- the negotiation
   * continues rather than collapsing.
   */
  async propose(input: ProposeInput): Promise<ProposeResult> {
    const signed = this.#store.getMandate(input.mandate_id);
    if (signed === undefined) {
      throw new EngineError(`no such mandate: ${input.mandate_id}`);
    }
    const profile = this.#store.getMerchant(input.proposal.merchant_id);
    if (profile === undefined) {
      throw new EngineError(`no such merchant: ${input.proposal.merchant_id}`);
    }

    const registeredKey = this.#store.getPrincipalKey(signed.mandate.principal_id) ?? "";
    const state = this.#store.getMandateState(input.mandate_id) ?? {
      consumed_paise: paise(0),
      txn_count: 0,
      status: "active" as const,
    };
    const catalog = this.#store.catalogFor(input.proposal.merchant_id);

    const baseInput = (proposal: Proposal): DwaarInput => ({
      signed_mandate: signed,
      registered_public_key: registeredKey,
      profile,
      catalog,
      proposal,
      ledger_state: { consumed_paise: state.consumed_paise, txn_count: state.txn_count },
      now: this.#now(),
      frozen: this.#store.isFrozen(),
      spent_token_ids: this.#store.spentTokenIds(),
    });

    this.#log("OFFER_PROPOSED", {
      actor: { type: "merchant_agent", id: "agt_revenue" },
      session_id: input.session_id,
      delegation_scope: { mandate_id: input.mandate_id, scope_hash: hashValue(signed.mandate.scope) },
      ...(input.llm === undefined ? {} : { llm: { ...input.llm } }),
      detail: {
        lines: input.proposal.lines.length,
        quoted_total_paise: input.proposal.quoted_total_paise,
        rationale: input.proposal.rationale,
      },
    });

    let proposal = input.proposal;
    let decision = evaluate(baseInput(proposal));
    let repaired = false;
    let adjustments: string[] = [];

    if (
      decision.outcome === "DENY" &&
      (input.autoRepair ?? true) &&
      REPAIRABLE.has(decision.violation.rule_id)
    ) {
      this.#log("DRIFT_BLOCKED", {
        session_id: input.session_id,
        decision: {
          outcome: "DENY",
          rule_ids: [decision.violation.rule_id],
          evidence: [decision.violation],
        },
        detail: { note: "repairable violation; clamping to the lowest legal price" },
      });

      const repair = repairProposal(proposal, profile, catalog);
      if (repair.changed) {
        proposal = repair.proposal;
        adjustments = repair.adjustments;
        repaired = true;
        decision = evaluate(baseInput(proposal));
        this.#log("REPRICED", {
          session_id: input.session_id,
          detail: { adjustments, new_total_paise: proposal.quoted_total_paise },
        });
      }
    }

    this.#log("DWAAR_DECISION", {
      session_id: input.session_id,
      delegation_scope: { mandate_id: input.mandate_id, scope_hash: hashValue(signed.mandate.scope) },
      envelope: this.#envelope(input.mandate_id),
      decision: {
        outcome: decision.outcome,
        rule_ids: decision.rules.map((r) => r.rule_id),
        evidence: decision.rules,
      },
    });

    if (decision.outcome === "DENY") {
      const rule = decision.violation.rule_id;
      const breachEvent: EventType =
        rule === "DRIFT.AMOUNT_MISMATCH"
          ? "DRIFT_BLOCKED"
          : rule === "TOKEN.REPLAY"
            ? "REPLAY_BLOCKED"
            : rule === "INVENTORY.INSUFFICIENT"
              ? "INVENTORY_CONFLICT"
              : rule === "CIRCUIT.FROZEN"
                ? "CIRCUIT_FROZEN"
                : "MANDATE_BREACH_BLOCKED";

      this.#log(breachEvent, {
        session_id: input.session_id,
        decision: { outcome: "DENY", rule_ids: [rule], evidence: [decision.violation] },
        detail: { note: "no rail call was made" },
      });
      return { kind: "DENIED", decision, rule_id: rule };
    }

    /* Allowed. Reserve stock before anything irreversible happens. */
    const cart = decision.cart;
    const reserved: { sku: string; qty: number }[] = [];
    for (const line of cart.lines) {
      const r = this.#store.reserveStock(line.sku, line.qty);
      if (!r.ok) {
        for (const back of reserved) this.#store.releaseStock(back.sku, back.qty);
        this.#log("INVENTORY_CONFLICT", {
          session_id: input.session_id,
          detail: { sku: line.sku, requested: line.qty, reason: r.reason },
        });
        const violation = {
          rule_id: "INVENTORY.INSUFFICIENT" as const,
          passed: false,
          observed: r.available,
          limit: line.qty,
          message: `Stock for ${line.sku} was taken by another buyer before this cart settled.`,
        };
        return {
          kind: "DENIED",
          decision: { outcome: "DENY", rules: [...decision.rules, violation], violation },
          rule_id: "INVENTORY.INSUFFICIENT",
        };
      }
      reserved.push({ sku: line.sku, qty: line.qty });
    }

    /* Mint a single-use, cart-bound, expiring authorisation. */
    const hash = cartHash(cart);
    const issuedAt = this.#now();
    const token: IntentToken = {
      token_id: newId("intentToken"),
      mandate_id: input.mandate_id,
      cart_hash: hash,
      amount_paise: decision.computed_paise,
      nonce: newNonce(),
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + this.#tokenTtlMs).toISOString(),
    };
    this.#store.issueToken(token);

    /* The order amount comes from Dwaar, never from the proposal. */
    const order = await this.#rail.createOrder({
      amount: decision.computed_paise,
      receipt: receiptFor(token.token_id),
      notes: {
        mercury: "1",
        mandate_id: input.mandate_id,
        agent_id: signed.mandate.agent_id,
        intent_token_id: token.token_id,
        cart_hash: hash,
        sakshi_seq: String(this.#sakshi.count() + 1),
      },
    });

    this.#store.putOrder({
      order_id: order.id,
      mandate_id: input.mandate_id,
      token_id: token.token_id,
      cart_hash: hash,
      amount: decision.computed_paise,
      status: "created",
    });

    this.#log("ORDER_CREATED", {
      actor: { type: "razorpay", id: order.id },
      session_id: input.session_id,
      intent_token_id: token.token_id,
      cart_mandate_hash: hash,
      envelope: this.#envelope(input.mandate_id),
      razorpay: { order_id: order.id },
      detail: { amount_paise: decision.computed_paise, receipt: order.receipt },
    });

    if (decision.outcome === "ALLOW_WITH_STEPUP") {
      const link = await this.#rail.createPaymentLink({
        amount: decision.computed_paise,
        description: `Approve ${cart.lines.length} item(s) from ${profile.display_name}`,
        reference_id: token.token_id,
        upi_link: true,
        notes: { mandate_id: input.mandate_id, order_id: order.id },
      });
      this.#log("STEPUP_ISSUED", {
        session_id: input.session_id,
        intent_token_id: token.token_id,
        razorpay: { order_id: order.id, link_id: link.id },
        detail: { reason: decision.step_up, short_url: link.short_url },
      });
      return {
        kind: "STEP_UP_REQUIRED",
        decision,
        token,
        cart,
        order_id: order.id,
        link_url: link.short_url,
        repaired,
        adjustments,
      };
    }

    return {
      kind: "AUTHORISED",
      decision,
      token,
      cart,
      order_id: order.id,
      repaired,
      adjustments,
    };
  }

  /* --------------------------------------------------------------- settle */

  /**
   * Redeem an intent token against an order.
   *
   * Spends the token first (F7), then attempts payment with a bounded retry
   * budget (F2), verifies the checkout signature before trusting anything, and
   * only then draws down the envelope.
   */
  async settle(args: {
    order_id: string;
    token_id: string;
    session_id: string;
    vpa?: string;
    /** Simulate the customer paying. FixtureRail only. */
    simulate?: (orderId: string, vpa: string) => Promise<{ paymentId: string; signature: string; failed: boolean }>;
  }): Promise<SettleResult> {
    const order = this.#store.getOrder(args.order_id);
    if (order === undefined) return { kind: "REJECTED", reason: `no such order: ${args.order_id}` };

    const spend = this.#store.spendToken(args.token_id);
    if (!spend.ok) {
      this.#log("REPLAY_BLOCKED", {
        session_id: args.session_id,
        intent_token_id: args.token_id,
        decision: {
          outcome: "DENY",
          rule_ids: ["TOKEN.REPLAY"],
          evidence: [
            {
              rule_id: "TOKEN.REPLAY",
              passed: false,
              observed: 1,
              limit: 0,
              message: `Intent token ${args.token_id} is ${spend.reason}.`,
            },
          ],
        },
        detail: { note: "no duplicate order was created" },
      });
      return { kind: "REJECTED", reason: spend.reason, rule_id: "TOKEN.REPLAY" };
    }

    const vpa = args.vpa ?? TEST_VPA_SUCCESS;
    let attempts = 0;
    let lastFailure = "";

    while (attempts <= this.#maxRetries) {
      attempts += 1;
      const sim = await args.simulate?.(args.order_id, vpa);
      if (sim === undefined) {
        return { kind: "REJECTED", reason: "no payment simulator supplied (live mode is M8)" };
      }

      if (sim.failed) {
        lastFailure = sim.paymentId;
        this.#log("PAYMENT_FAILED", {
          actor: { type: "razorpay", id: sim.paymentId },
          session_id: args.session_id,
          razorpay: { order_id: args.order_id, payment_id: sim.paymentId },
          detail: { attempt: attempts, vpa },
        });
        if (attempts <= this.#maxRetries) {
          this.#log("RETRY_BOUNDED", {
            session_id: args.session_id,
            detail: {
              attempt: attempts,
              max_retries: this.#maxRetries,
              note: "retry re-checked against the remaining envelope",
            },
          });
          continue;
        }
        break;
      }

      /* Verify before trusting. A bad signature means we never captured. */
      if (!this.#rail.verifyCheckoutSignature(args.order_id, sim.paymentId, sim.signature)) {
        this.#log("WEBHOOK_REJECTED", {
          session_id: args.session_id,
          razorpay: { order_id: args.order_id, payment_id: sim.paymentId, signature_verified: false },
          detail: { note: "checkout signature mismatch; payment not captured" },
        });
        return { kind: "REJECTED", reason: "checkout signature mismatch" };
      }

      const captured = await this.#rail.capturePayment(sim.paymentId, paise(order.amount));
      this.#store.setOrderStatus(args.order_id, "paid", captured.id);
      const state = this.#store.consumeEnvelope(order.mandate_id, paise(order.amount));

      this.#log("PAYMENT_CAPTURED", {
        actor: { type: "razorpay", id: captured.id },
        session_id: args.session_id,
        intent_token_id: args.token_id,
        cart_mandate_hash: order.cart_hash,
        envelope: this.#envelope(order.mandate_id),
        razorpay: { order_id: args.order_id, payment_id: captured.id, signature_verified: true },
        detail: { amount_paise: order.amount, attempts },
      });

      return {
        kind: "CAPTURED",
        payment_id: captured.id,
        amount: paise(order.amount),
        consumed_paise: state.consumed_paise,
      };
    }

    /* Retries exhausted -- fall back to a human-present UPI link rather than looping. */
    const link = await this.#rail.createPaymentLink({
      amount: paise(order.amount),
      description: "Payment retry - approve on your UPI app",
      reference_id: `${args.token_id}_retry`,
      upi_link: true,
      notes: { order_id: args.order_id, mandate_id: order.mandate_id },
    });
    this.#log("STEPUP_ISSUED", {
      session_id: args.session_id,
      razorpay: { order_id: args.order_id, link_id: link.id, payment_id: lastFailure },
      detail: {
        reason: "AUTOMATED_RETRIES_EXHAUSTED",
        attempts,
        short_url: link.short_url,
        note: "handing control back to a human rather than retrying indefinitely",
      },
    });
    return { kind: "FAILED_FALLBACK_LINK", attempts, link_url: link.short_url };
  }

  /**
   * F3 recovery: money was captured but the goods cannot be delivered.
   * Refund automatically, put the stock back, and restore the envelope, so the
   * principal is left exactly where they started. Zero financial leakage.
   */
  async compensate(args: {
    order_id: string;
    payment_id: string;
    session_id: string;
    reason: string;
    restore: { sku: string; qty: number }[];
  }): Promise<SettleResult> {
    const order = this.#store.getOrder(args.order_id);
    if (order === undefined) return { kind: "REJECTED", reason: `no such order: ${args.order_id}` };

    const refund = await this.#rail.refund(args.payment_id, paise(order.amount), {
      reason: args.reason,
      order_id: args.order_id,
    });

    for (const r of args.restore) this.#store.releaseStock(r.sku, r.qty);
    this.#store.restoreEnvelope(order.mandate_id, paise(order.amount));
    this.#store.setOrderStatus(args.order_id, "refunded");

    this.#log("AUTO_REFUND_ISSUED", {
      actor: { type: "razorpay", id: refund.id },
      session_id: args.session_id,
      envelope: this.#envelope(order.mandate_id),
      razorpay: { order_id: args.order_id, payment_id: args.payment_id, refund_id: refund.id },
      detail: {
        reason: args.reason,
        amount_paise: order.amount,
        note: "stock released and envelope restored; principal is whole",
      },
    });

    return { kind: "REFUNDED", refund_id: refund.id, reason: args.reason };
  }

  /* -------------------------------------------------------------- webhooks */

  /** F4/F5: verify, dedupe, and record. Never mutates order state on rejection. */
  handleWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookVerdict {
    const verdict = this.#gate.handle(rawBody, headers);

    if (verdict.kind === "REJECTED_SIGNATURE" || verdict.kind === "REJECTED_MALFORMED") {
      this.#log("WEBHOOK_REJECTED", {
        actor: { type: "system", id: "webhook" },
        razorpay: { signature_verified: false },
        detail: { kind: verdict.kind, reason: verdict.reason, note: "order state untouched" },
      });
      return verdict;
    }

    if (verdict.kind === "DUPLICATE") {
      this.#log("WEBHOOK_DEDUPED", {
        actor: { type: "system", id: "webhook" },
        razorpay: { event_id: verdict.event_id },
        detail: { note: "already processed; no-op" },
      });
      return verdict;
    }

    this.#log("WEBHOOK_ACCEPTED", {
      actor: { type: "razorpay", id: verdict.event_id },
      razorpay: { event_id: verdict.event_id, signature_verified: true },
      detail: { event: verdict.event.event },
    });
    return verdict;
  }

  /** Close an envelope and record the residual released back to the principal. */
  closeEnvelope(mandateId: string, sessionId: string): { released_paise: Paise } {
    const result = this.#store.closeEnvelope(mandateId);
    this.#log("ENVELOPE_RESIDUAL_RELEASED", {
      actor: { type: "system", id: "mercury" },
      session_id: sessionId,
      delegation_scope: { mandate_id: mandateId, scope_hash: "" },
      envelope: this.#envelope(mandateId),
      detail: {
        released_paise: result.released_paise,
        note: "unspent authority returned to the principal, per the Reserve Pay model",
      },
    });
    return result;
  }

  setFrozen(frozen: boolean, sessionId: string): void {
    this.#store.setFrozen(frozen);
    this.#log(frozen ? "CIRCUIT_FROZEN" : "CIRCUIT_UNFROZEN", {
      actor: { type: "human", id: "merchant" },
      session_id: sessionId,
      detail: { frozen },
    });
  }

  /** Total by construction: an unknown mandate reports a zero envelope rather
   *  than undefined, so every ledger entry carries budget context. */
  #envelope(mandateId: string): { reserved_paise: number; consumed_paise: number; remaining_paise: number } {
    const signed = this.#store.getMandate(mandateId);
    const state = this.#store.getMandateState(mandateId);
    if (signed === undefined || state === undefined) {
      return { reserved_paise: 0, consumed_paise: 0, remaining_paise: 0 };
    }
    return {
      reserved_paise: signed.mandate.reserved_paise,
      consumed_paise: state.consumed_paise,
      remaining_paise: Math.max(0, signed.mandate.reserved_paise - state.consumed_paise),
    };
  }
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}
