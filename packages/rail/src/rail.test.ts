import { describe, expect, it } from "vitest";
import { paise } from "@mercury/core";
import { FixtureRail, RailError, TEST_VPA_FAILURE, TEST_VPA_SUCCESS } from "./fixture.js";
import { LiveRail } from "./live.js";
import { computeCheckoutSignature, computeWebhookSignature } from "./signatures.js";
import { InMemorySeenEvents, WebhookGate, advanceStatus } from "./webhook.js";

function rail(): FixtureRail {
  return new FixtureRail({ keySecret: "sec_k", webhookSecret: "sec_w" });
}

async function anOrder(r: FixtureRail, amount = 55_000) {
  return r.createOrder({
    amount: paise(amount),
    receipt: "mrc_itk_test_1",
    notes: { mandate_id: "mnd_1", sakshi_seq: "7" },
  });
}

describe("orders", () => {
  it("creates an order with deterministic ids and paise amounts", async () => {
    const r = rail();
    const o = await anOrder(r);
    expect(o.id).toBe("order_FIX0000001");
    expect(o.amount).toBe(55_000);
    expect(o.currency).toBe("INR");
    expect(o.status).toBe("created");
    expect(o.amount_due).toBe(55_000);
  });

  it("carries the Mercury audit trail in notes, so an order traces back to its mandate", async () => {
    const r = rail();
    const o = await anOrder(r);
    expect(o.notes["mandate_id"]).toBe("mnd_1");
    expect(o.notes["sakshi_seq"]).toBe("7");
  });

  it("enforces the Razorpay receipt limit of 40 characters", async () => {
    const r = rail();
    await expect(
      r.createOrder({ amount: paise(100), receipt: "x".repeat(41), notes: {} }),
    ).rejects.toThrow(RailError);
  });

  it("enforces the Razorpay notes limits (15 pairs, 256 chars)", async () => {
    const r = rail();
    const tooMany = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]),
    ) as Record<string, string>;
    await expect(r.createOrder({ amount: paise(100), receipt: "r", notes: tooMany })).rejects.toThrow(
      /15 key-value pairs/,
    );
    await expect(
      r.createOrder({ amount: paise(100), receipt: "r", notes: { big: "x".repeat(257) } }),
    ).rejects.toThrow(/256 characters/);
  });
});

describe("checkout simulation mirrors Razorpay test mode", () => {
  it("success@razorpay authorises the payment", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id, TEST_VPA_SUCCESS);
    expect(payment.status).toBe("authorized");
    expect(payment.error_code).toBeUndefined();
  });

  it("failure@razorpay fails the payment with a Razorpay-shaped error", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id, TEST_VPA_FAILURE);
    expect(payment.status).toBe("failed");
    expect(payment.error_code).toBe("BAD_REQUEST_ERROR");
    expect(payment.error_reason).toBe("payment_failed");
  });

  it("refuses to capture a failed payment", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id, TEST_VPA_FAILURE);
    await expect(r.capturePayment(payment.id, paise(55_000))).rejects.toThrow(/failed payment/);
  });

  it("capture is idempotent and marks the order paid", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id);
    const c1 = await r.capturePayment(payment.id, paise(55_000));
    const c2 = await r.capturePayment(payment.id, paise(55_000));
    expect(c1.status).toBe("captured");
    expect(c2.id).toBe(c1.id);
    const order = await r.fetchOrder(o.id);
    expect(order?.status).toBe("paid");
    expect(order?.amount_due).toBe(0);
  });
});

describe("refunds -- the compensating transaction for F3", () => {
  it("refunds a captured payment", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id);
    await r.capturePayment(payment.id, paise(55_000));
    const refund = await r.refund(payment.id, paise(55_000), { reason: "INVENTORY_CONFLICT" });
    expect(refund.status).toBe("processed");
    expect(refund.amount).toBe(55_000);
    expect(refund.notes["reason"]).toBe("INVENTORY_CONFLICT");
    expect((await r.fetchPayment(payment.id))?.status).toBe("refunded");
  });

  it("refuses to refund a payment that was never captured", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id);
    await expect(r.refund(payment.id, paise(55_000))).rejects.toThrow(/only refund a captured/);
  });
});

describe("checkout signature", () => {
  it("accepts the genuine signature", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment, signature } = await r.simulateCheckout(o.id);
    expect(r.verifyCheckoutSignature(o.id, payment.id, signature)).toBe(true);
  });

  it("rejects a signature computed over a different order or payment", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id);
    const wrong = computeCheckoutSignature("order_OTHER", payment.id, "sec_k");
    expect(r.verifyCheckoutSignature(o.id, payment.id, wrong)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.simulateCheckout(o.id);
    const wrong = computeCheckoutSignature(o.id, payment.id, "not_the_secret");
    expect(r.verifyCheckoutSignature(o.id, payment.id, wrong)).toBe(false);
  });

  it("rejects malformed signatures without throwing", () => {
    const r = rail();
    expect(r.verifyCheckoutSignature("a", "b", "")).toBe(false);
    expect(r.verifyCheckoutSignature("a", "b", "zzzz")).toBe(false);
  });
});

describe("webhook gate", () => {
  async function delivery() {
    const r = rail();
    const o = await anOrder(r);
    await r.simulateCheckout(o.id);
    const d = r.deliveryFor("payment.authorized");
    if (d === undefined) throw new Error("no delivery emitted");
    return { r, ...d };
  }

  it("accepts a genuine delivery", async () => {
    const { r, body, signature } = await delivery();
    const gate = new WebhookGate(r);
    const v = gate.handle(body, {
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": "evt_1",
    });
    expect(v.kind).toBe("ACCEPTED");
    if (v.kind !== "ACCEPTED") throw new Error("unreachable");
    expect(v.event.event).toBe("payment.authorized");
  });

  /* ------------------------------------------------------------------ F4 */

  it("F4: rejects a forged signature and never parses the body", async () => {
    const { r, body } = await delivery();
    const gate = new WebhookGate(r);
    const v = gate.handle(body, {
      "x-razorpay-signature": "deadbeef".repeat(8),
      "x-razorpay-event-id": "evt_forged",
    });
    expect(v.kind).toBe("REJECTED_SIGNATURE");
  });

  it("F4: rejects a body that was altered after signing", async () => {
    const { r, body, signature } = await delivery();
    const gate = new WebhookGate(r);
    const tampered = body.replace('"amount":55000', '"amount":1');
    const v = gate.handle(tampered, {
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": "evt_tampered",
    });
    expect(v.kind).toBe("REJECTED_SIGNATURE");
  });

  it("F4: rejects a missing signature header", async () => {
    const { r, body } = await delivery();
    const gate = new WebhookGate(r);
    expect(gate.handle(body, { "x-razorpay-event-id": "evt_x" }).kind).toBe("REJECTED_SIGNATURE");
  });

  it("F4: a forged delivery leaves the genuine one still processable", async () => {
    const { r, body, signature } = await delivery();
    const gate = new WebhookGate(r);
    gate.handle(body, { "x-razorpay-signature": "00".repeat(32), "x-razorpay-event-id": "evt_1" });
    // The forged attempt must not have consumed the event id.
    const v = gate.handle(body, {
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": "evt_1",
    });
    expect(v.kind).toBe("ACCEPTED");
  });

  /* ------------------------------------------------------------------ F5 */

  it("F5: deduplicates a retried delivery on x-razorpay-event-id", async () => {
    const { r, body, signature } = await delivery();
    const gate = new WebhookGate(r, new InMemorySeenEvents());
    const headers = { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_dup" };
    expect(gate.handle(body, headers).kind).toBe("ACCEPTED");
    expect(gate.handle(body, headers).kind).toBe("DUPLICATE");
    expect(gate.handle(body, headers).kind).toBe("DUPLICATE");
  });

  it("rejects a delivery with no event id", async () => {
    const { r, body, signature } = await delivery();
    const gate = new WebhookGate(r);
    const v = gate.handle(body, { "x-razorpay-signature": signature });
    expect(v.kind).toBe("REJECTED_MALFORMED");
  });

  it("rejects a validly-signed body that is not a Razorpay event", async () => {
    const r = rail();
    const body = JSON.stringify({ hello: "world" });
    const gate = new WebhookGate(r);
    const v = gate.handle(body, {
      "x-razorpay-signature": computeWebhookSignature(body, "sec_w"),
      "x-razorpay-event-id": "evt_junk",
    });
    expect(v.kind).toBe("REJECTED_MALFORMED");
  });
});

describe("F5: payment status advances monotonically", () => {
  it("captured arriving before authorized still converges to captured", () => {
    let s = advanceStatus("created", "captured");
    expect(s).toBe("captured");
    s = advanceStatus(s, "authorized"); // late arrival
    expect(s).toBe("captured");
  });

  it("never regresses on replay", () => {
    let s: ReturnType<typeof advanceStatus> = "created";
    for (const observed of ["authorized", "captured", "authorized", "captured", "created"] as const) {
      s = advanceStatus(s, observed);
    }
    expect(s).toBe("captured");
  });

  it("advances to refunded and stays there", () => {
    let s = advanceStatus("captured", "refunded");
    expect(s).toBe("refunded");
    expect(advanceStatus(s, "captured")).toBe("refunded");
  });
});

describe("LiveRail guardrail", () => {
  it("refuses a key that is not test mode", () => {
    expect(
      () => new LiveRail({ keyId: "rzp_live_abc", keySecret: "s", webhookSecret: "w" }),
    ).toThrow(/test mode/);
  });

  it("accepts a test key", () => {
    expect(
      () => new LiveRail({ keyId: "rzp_test_abc", keySecret: "s", webhookSecret: "w" }),
    ).not.toThrow();
  });

  it("shares signature semantics with FixtureRail", () => {
    const live = new LiveRail({ keyId: "rzp_test_abc", keySecret: "sec_k", webhookSecret: "sec_w" });
    const sig = computeCheckoutSignature("order_1", "pay_1", "sec_k");
    expect(live.verifyCheckoutSignature("order_1", "pay_1", sig)).toBe(true);
    expect(rail().verifyCheckoutSignature("order_1", "pay_1", sig)).toBe(true);
  });
});
