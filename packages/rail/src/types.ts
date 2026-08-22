import type { Paise } from "@mercury/core";

/**
 * Razorpay entity shapes, narrowed to the fields Mercury actually uses.
 *
 * These mirror the real API responses so `FixtureRail` and `LiveRail` are
 * interchangeable: swapping RAIL_MODE must not change a single call site.
 */

export type OrderStatus = "created" | "attempted" | "paid";
export type PaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";

export interface RzpOrder {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: "INR";
  receipt: string;
  status: OrderStatus;
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface RzpPayment {
  id: string;
  entity: "payment";
  amount: number;
  currency: "INR";
  status: PaymentStatus;
  order_id: string;
  method: "upi" | "card" | "netbanking";
  vpa?: string;
  captured: boolean;
  error_code?: string;
  error_description?: string;
  error_reason?: string;
  created_at: number;
}

export interface RzpRefund {
  id: string;
  entity: "refund";
  amount: number;
  currency: "INR";
  payment_id: string;
  status: "pending" | "processed" | "failed";
  speed_processed: "normal" | "optimum";
  notes: Record<string, string>;
  created_at: number;
}

export interface RzpPaymentLink {
  id: string;
  entity: "payment_link";
  amount: number;
  currency: "INR";
  status: "created" | "paid" | "cancelled" | "expired";
  short_url: string;
  upi_link: boolean;
  reference_id: string;
  notes: Record<string, string>;
  created_at: number;
}

/* ------------------------------------------------------------------- inputs */

export interface OrderInput {
  amount: Paise;
  /** Max 40 chars, unique per order. */
  receipt: string;
  /**
   * Max 15 pairs, 256 chars each. Mercury writes the audit trail here, so an
   * order in the Razorpay dashboard can be traced back to the exact mandate,
   * intent token, cart hash and ledger sequence that authorised it.
   */
  notes: Record<string, string>;
}

export interface PaymentLinkInput {
  amount: Paise;
  description: string;
  reference_id: string;
  /** Generate a UPI intent link (the human step-up path). */
  upi_link: boolean;
  notes: Record<string, string>;
  /** Unix seconds. */
  expire_by?: number;
}

/* ------------------------------------------------------------------ webhooks */

export const WEBHOOK_EVENTS = [
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",
  "refund.processed",
  "payment_link.paid",
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEnvelope {
  entity: "event";
  account_id: string;
  event: WebhookEventName;
  contains: string[];
  payload: {
    payment?: { entity: RzpPayment };
    order?: { entity: RzpOrder };
    refund?: { entity: RzpRefund };
    payment_link?: { entity: RzpPaymentLink };
  };
  created_at: number;
}

/**
 * The outcome of handing a raw webhook body to the rail.
 *
 * `REJECTED_SIGNATURE` is deliberately distinct from an error: a forged webhook
 * is an expected, handled condition, not an exception. It must never mutate
 * order state.
 */
export type WebhookVerdict =
  | { kind: "ACCEPTED"; event: WebhookEnvelope; event_id: string }
  | { kind: "DUPLICATE"; event_id: string }
  | { kind: "REJECTED_SIGNATURE"; reason: string }
  | { kind: "REJECTED_MALFORMED"; reason: string };

/* ---------------------------------------------------------------- the port */

/**
 * The one interface both rails implement. Nothing above this line knows whether
 * it is talking to a recorded fixture or to Razorpay.
 */
export interface RazorpayPort {
  readonly mode: "fixture" | "live";

  createOrder(input: OrderInput): Promise<RzpOrder>;
  fetchOrder(orderId: string): Promise<RzpOrder | undefined>;
  createPaymentLink(input: PaymentLinkInput): Promise<RzpPaymentLink>;
  fetchPayment(paymentId: string): Promise<RzpPayment | undefined>;
  capturePayment(paymentId: string, amount: Paise): Promise<RzpPayment>;
  refund(paymentId: string, amount: Paise, notes?: Record<string, string>): Promise<RzpRefund>;

  /** HMAC_SHA256(order_id + "|" + payment_id, key_secret) */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** HMAC_SHA256(rawBody, webhook_secret) */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}
