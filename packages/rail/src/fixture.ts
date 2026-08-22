import { type Paise, paise } from "@mercury/core";
import {
  computeCheckoutSignature,
  computeWebhookSignature,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "./signatures.js";
import type {
  OrderInput,
  PaymentLinkInput,
  RazorpayPort,
  RzpOrder,
  RzpPayment,
  RzpPaymentLink,
  RzpRefund,
  WebhookEnvelope,
  WebhookEventName,
} from "./types.js";

/**
 * FixtureRail -- Razorpay, recorded.
 *
 * Reproduces the response shapes and lifecycle of Razorpay test mode with no
 * network, no account and no tunnel. Every id is deterministic, so a test that
 * passes once passes identically forever.
 *
 * This exists because we had no Razorpay account when the rail was built, but
 * it earns its place regardless: all seven engineered failures -- including the
 * forged webhook and the out-of-order delivery -- are reproducible here, which
 * they would not be against a live endpoint.
 *
 * The VPA convention mirrors Razorpay test mode exactly:
 *   success@razorpay -> payment authorised
 *   failure@razorpay -> payment failed
 */

export const TEST_VPA_SUCCESS = "success@razorpay";
export const TEST_VPA_FAILURE = "failure@razorpay";

export interface FixtureRailOptions {
  keySecret?: string;
  webhookSecret?: string;
  accountId?: string;
  /** Fixed clock, so created_at is deterministic too. */
  now?: () => number;
}

export class FixtureRail implements RazorpayPort {
  readonly mode = "fixture" as const;

  readonly #keySecret: string;
  readonly #webhookSecret: string;
  readonly #accountId: string;
  readonly #now: () => number;

  #counter = 0;
  readonly #orders = new Map<string, RzpOrder>();
  readonly #payments = new Map<string, RzpPayment>();
  readonly #refunds = new Map<string, RzpRefund>();
  readonly #links = new Map<string, RzpPaymentLink>();
  readonly #emitted: WebhookEnvelope[] = [];

  constructor(opts: FixtureRailOptions = {}) {
    this.#keySecret = opts.keySecret ?? "fixture_key_secret";
    this.#webhookSecret = opts.webhookSecret ?? "fixture_webhook_secret";
    this.#accountId = opts.accountId ?? "acc_FIXTURE";
    this.#now = opts.now ?? (() => 1_780_000_000);
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_FIX${String(this.#counter).padStart(7, "0")}`;
  }

  /* ------------------------------------------------------------- port impl */

  async createOrder(input: OrderInput): Promise<RzpOrder> {
    if (input.receipt.length > 40) {
      throw new RailError(`receipt exceeds 40 characters: ${input.receipt.length}`);
    }
    if (Object.keys(input.notes).length > 15) {
      throw new RailError("notes may contain at most 15 key-value pairs");
    }
    for (const [k, v] of Object.entries(input.notes)) {
      if (v.length > 256) throw new RailError(`note "${k}" exceeds 256 characters`);
    }

    const order: RzpOrder = {
      id: this.#id("order"),
      entity: "order",
      amount: input.amount,
      amount_paid: 0,
      amount_due: input.amount,
      currency: "INR",
      receipt: input.receipt,
      status: "created",
      attempts: 0,
      notes: input.notes,
      created_at: this.#now(),
    };
    this.#orders.set(order.id, order);
    return order;
  }

  async fetchOrder(orderId: string): Promise<RzpOrder | undefined> {
    return this.#orders.get(orderId);
  }

  async createPaymentLink(input: PaymentLinkInput): Promise<RzpPaymentLink> {
    const link: RzpPaymentLink = {
      id: this.#id("plink"),
      entity: "payment_link",
      amount: input.amount,
      currency: "INR",
      status: "created",
      short_url: `https://rzp.io/i/FIX${this.#counter}`,
      upi_link: input.upi_link,
      reference_id: input.reference_id,
      notes: input.notes,
      created_at: this.#now(),
    };
    this.#links.set(link.id, link);
    return link;
  }

  async fetchPayment(paymentId: string): Promise<RzpPayment | undefined> {
    return this.#payments.get(paymentId);
  }

  async capturePayment(paymentId: string, amount: Paise): Promise<RzpPayment> {
    const p = this.#payments.get(paymentId);
    if (p === undefined) throw new RailError(`no such payment: ${paymentId}`);
    if (p.status === "failed") throw new RailError(`cannot capture a failed payment: ${paymentId}`);
    if (p.status === "captured") return p; // idempotent

    const captured: RzpPayment = { ...p, status: "captured", captured: true, amount };
    this.#payments.set(paymentId, captured);

    const order = this.#orders.get(p.order_id);
    if (order !== undefined) {
      this.#orders.set(order.id, {
        ...order,
        status: "paid",
        amount_paid: amount,
        amount_due: Math.max(0, order.amount - amount),
      });
    }

    this.#emit("payment.captured", { payment: { entity: captured } });
    return captured;
  }

  async refund(
    paymentId: string,
    amount: Paise,
    notes: Record<string, string> = {},
  ): Promise<RzpRefund> {
    const p = this.#payments.get(paymentId);
    if (p === undefined) throw new RailError(`no such payment: ${paymentId}`);
    if (p.status !== "captured") {
      throw new RailError(`can only refund a captured payment; ${paymentId} is ${p.status}`);
    }

    const r: RzpRefund = {
      id: this.#id("rfnd"),
      entity: "refund",
      amount,
      currency: "INR",
      payment_id: paymentId,
      status: "processed",
      speed_processed: "normal",
      notes,
      created_at: this.#now(),
    };
    this.#refunds.set(r.id, r);
    this.#payments.set(paymentId, { ...p, status: "refunded" });
    this.#emit("refund.processed", { refund: { entity: r } });
    return r;
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return verifyCheckoutSignature(orderId, paymentId, signature, this.#keySecret);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyWebhookSignature(rawBody, signature, this.#webhookSecret);
  }

  /* ------------------------------------------------- fixture-only affordances */

  /**
   * Simulate a customer completing (or failing) checkout, exactly as Razorpay
   * test mode does based on the VPA used.
   */
  async simulateCheckout(
    orderId: string,
    vpa: string = TEST_VPA_SUCCESS,
  ): Promise<{ payment: RzpPayment; signature: string }> {
    const order = this.#orders.get(orderId);
    if (order === undefined) throw new RailError(`no such order: ${orderId}`);

    const failed = vpa === TEST_VPA_FAILURE;
    const payment: RzpPayment = {
      id: this.#id("pay"),
      entity: "payment",
      amount: paise(order.amount),
      currency: "INR",
      status: failed ? "failed" : "authorized",
      order_id: orderId,
      method: "upi",
      vpa,
      captured: false,
      ...(failed
        ? {
            error_code: "BAD_REQUEST_ERROR",
            error_description: "Payment was unsuccessful as the UPI request was declined.",
            error_reason: "payment_failed",
          }
        : {}),
      created_at: this.#now(),
    };

    this.#payments.set(payment.id, payment);
    this.#orders.set(orderId, { ...order, status: "attempted", attempts: order.attempts + 1 });

    this.#emit(failed ? "payment.failed" : "payment.authorized", {
      payment: { entity: payment },
    });

    return {
      payment,
      signature: computeCheckoutSignature(orderId, payment.id, this.#keySecret),
    };
  }

  /** Sign a body with the webhook secret -- for constructing genuine test deliveries. */
  signWebhook(rawBody: string): string {
    return computeWebhookSignature(rawBody, this.#webhookSecret);
  }

  /** Webhook envelopes this rail has emitted, oldest first. */
  emitted(): readonly WebhookEnvelope[] {
    return this.#emitted;
  }

  /** The most recent envelope of a given type, as a raw body plus valid signature. */
  deliveryFor(event: WebhookEventName): { body: string; signature: string } | undefined {
    const found = [...this.#emitted].reverse().find((e) => e.event === event);
    if (found === undefined) return undefined;
    const body = JSON.stringify(found);
    return { body, signature: this.signWebhook(body) };
  }

  #emit(event: WebhookEventName, payload: WebhookEnvelope["payload"]): void {
    this.#emitted.push({
      entity: "event",
      account_id: this.#accountId,
      event,
      contains: Object.keys(payload),
      payload,
      created_at: this.#now(),
    });
  }
}

export class RailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailError";
  }
}
