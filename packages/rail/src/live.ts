import { type Paise, paise } from "@mercury/core";
import { verifyCheckoutSignature, verifyWebhookSignature } from "./signatures.js";
import { RailError } from "./fixture.js";
import type {
  OrderInput,
  PaymentLinkInput,
  RazorpayPort,
  RzpOrder,
  RzpPayment,
  RzpPaymentLink,
  RzpRefund,
} from "./types.js";

/**
 * LiveRail -- the real Razorpay API, test mode only.
 *
 * Same interface as FixtureRail, so nothing above the port changes when
 * RAIL_MODE flips. Guarded so it refuses to start against a live key: this
 * project is never meant to touch production credentials.
 */

const API = "https://api.razorpay.com/v1";

export interface LiveRailOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
}

export class LiveRail implements RazorpayPort {
  readonly mode = "live" as const;

  readonly #keyId: string;
  readonly #keySecret: string;
  readonly #webhookSecret: string;
  readonly #fetch: typeof fetch;

  constructor(opts: LiveRailOptions) {
    if (!opts.keyId.startsWith("rzp_test_")) {
      throw new RailError(
        `LiveRail refuses a key that is not test mode: "${opts.keyId.slice(0, 12)}...". ` +
          `Mercury is a test-mode project by design.`,
      );
    }
    this.#keyId = opts.keyId;
    this.#keySecret = opts.keySecret;
    this.#webhookSecret = opts.webhookSecret;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  get #auth(): string {
    return `Basic ${Buffer.from(`${this.#keyId}:${this.#keySecret}`).toString("base64")}`;
  }

  async #call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.#fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: this.#auth,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new RailError(`Razorpay ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  }

  async createOrder(input: OrderInput): Promise<RzpOrder> {
    return this.#call<RzpOrder>("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: input.amount,
        currency: "INR",
        receipt: input.receipt,
        notes: input.notes,
      }),
    });
  }

  async fetchOrder(orderId: string): Promise<RzpOrder | undefined> {
    try {
      return await this.#call<RzpOrder>(`/orders/${orderId}`);
    } catch {
      return undefined;
    }
  }

  async createPaymentLink(input: PaymentLinkInput): Promise<RzpPaymentLink> {
    return this.#call<RzpPaymentLink>("/payment_links", {
      method: "POST",
      body: JSON.stringify({
        amount: input.amount,
        currency: "INR",
        description: input.description,
        reference_id: input.reference_id,
        upi_link: input.upi_link,
        notes: input.notes,
        ...(input.expire_by === undefined ? {} : { expire_by: input.expire_by }),
      }),
    });
  }

  async fetchPayment(paymentId: string): Promise<RzpPayment | undefined> {
    try {
      return await this.#call<RzpPayment>(`/payments/${paymentId}`);
    } catch {
      return undefined;
    }
  }

  async capturePayment(paymentId: string, amount: Paise): Promise<RzpPayment> {
    return this.#call<RzpPayment>(`/payments/${paymentId}/capture`, {
      method: "POST",
      body: JSON.stringify({ amount, currency: "INR" }),
    });
  }

  async refund(
    paymentId: string,
    amount: Paise,
    notes: Record<string, string> = {},
  ): Promise<RzpRefund> {
    return this.#call<RzpRefund>(`/payments/${paymentId}/refund`, {
      method: "POST",
      body: JSON.stringify({ amount: paise(amount), notes }),
    });
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return verifyCheckoutSignature(orderId, paymentId, signature, this.#keySecret);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyWebhookSignature(rawBody, signature, this.#webhookSecret);
  }
}
