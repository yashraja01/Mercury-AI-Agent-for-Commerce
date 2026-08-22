import type { PaymentStatus, RazorpayPort, WebhookEnvelope, WebhookVerdict } from "./types.js";
import { WEBHOOK_EVENTS } from "./types.js";

/**
 * The webhook gate.
 *
 * Three properties this must have, and the reasons they matter:
 *
 *  1. Verify the signature against the RAW body, before parsing. A forged
 *     delivery is rejected without touching any state (F4).
 *  2. Deduplicate on `x-razorpay-event-id`. Razorpay retries, so the same
 *     event will arrive more than once (F5).
 *  3. Tolerate out-of-order delivery. Razorpay explicitly does not guarantee
 *     ordering, so payment state advances monotonically: a late `authorized`
 *     after a `captured` is ignored rather than regressing the payment (F5).
 */

/** Where processed event ids are remembered. Backed by SQLite in the app. */
export interface SeenEventStore {
  has(eventId: string): boolean;
  add(eventId: string): void;
}

export class InMemorySeenEvents implements SeenEventStore {
  readonly #ids = new Set<string>();
  has(eventId: string): boolean {
    return this.#ids.has(eventId);
  }
  add(eventId: string): void {
    this.#ids.add(eventId);
  }
}

export interface WebhookHeaders {
  "x-razorpay-signature"?: string;
  "x-razorpay-event-id"?: string;
}

export class WebhookGate {
  readonly #rail: RazorpayPort;
  readonly #seen: SeenEventStore;

  constructor(rail: RazorpayPort, seen: SeenEventStore = new InMemorySeenEvents()) {
    this.#rail = rail;
    this.#seen = seen;
  }

  /**
   * Process one delivery.
   *
   * Takes the raw body as a string on purpose: parsing and re-serialising JSON
   * changes the bytes and would break signature verification every time.
   */
  handle(rawBody: string, headers: WebhookHeaders): WebhookVerdict {
    const signature = headers["x-razorpay-signature"];
    if (signature === undefined || signature === "") {
      return { kind: "REJECTED_SIGNATURE", reason: "missing X-Razorpay-Signature header" };
    }

    // Signature first. Nothing below this line runs for a forged delivery.
    if (!this.#rail.verifyWebhookSignature(rawBody, signature)) {
      return { kind: "REJECTED_SIGNATURE", reason: "signature does not match the raw body" };
    }

    const eventId = headers["x-razorpay-event-id"];
    if (eventId === undefined || eventId === "") {
      return { kind: "REJECTED_MALFORMED", reason: "missing x-razorpay-event-id header" };
    }

    if (this.#seen.has(eventId)) {
      return { kind: "DUPLICATE", event_id: eventId };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      return {
        kind: "REJECTED_MALFORMED",
        reason: `body is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (!isEnvelope(parsed)) {
      return { kind: "REJECTED_MALFORMED", reason: "body is not a recognised Razorpay event" };
    }

    this.#seen.add(eventId);
    return { kind: "ACCEPTED", event: parsed, event_id: eventId };
  }
}

function isEnvelope(v: unknown): v is WebhookEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o["entity"] === "event" &&
    typeof o["event"] === "string" &&
    (WEBHOOK_EVENTS as readonly string[]).includes(o["event"]) &&
    typeof o["payload"] === "object" &&
    o["payload"] !== null
  );
}

/* ------------------------------------------------- monotonic payment state */

/**
 * Rank of each payment status. State may only move up.
 *
 * `failed` and `authorized` share a rank because they are alternative outcomes
 * of the same step; a payment never moves between them.
 */
const RANK: Record<PaymentStatus, number> = {
  created: 0,
  failed: 1,
  authorized: 1,
  captured: 2,
  refunded: 3,
};

export function statusRank(s: PaymentStatus): number {
  return RANK[s];
}

/**
 * Fold a newly observed status into the status we already hold.
 *
 * Returns the status to persist. Because this only ever advances, a `captured`
 * that arrives before its `authorized` still converges to `captured`, and the
 * late `authorized` is a no-op instead of a regression.
 */
export function advanceStatus(current: PaymentStatus, observed: PaymentStatus): PaymentStatus {
  return RANK[observed] > RANK[current] ? observed : current;
}
