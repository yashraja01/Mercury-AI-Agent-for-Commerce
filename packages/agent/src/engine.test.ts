import { describe, expect, it } from "vitest";
import {
  type CatalogItem,
  type MerchantProfile,
  type Proposal,
  type ReserveMandate,
  generateKeyPair,
  paise,
  rupees,
  signValue,
} from "@mercury/core";
import { FixtureRail, TEST_VPA_FAILURE, TEST_VPA_SUCCESS } from "@mercury/rail";
import { Sakshi } from "@mercury/sakshi";
import { Store } from "@mercury/store";
import { Engine } from "./engine.js";

/**
 * The settlement path, at the Engine.
 *
 * These are the two failure rows that had no end-to-end coverage: a payment
 * that declines (F2) and money captured for goods that cannot ship (F3's
 * second half). Both are about what happens *after* the gate has said yes,
 * which is exactly where a policy engine stops helping.
 */

const KEYS = generateKeyPair();
const AGENT_KEYS = generateKeyPair();

const PROFILE: MerchantProfile = {
  merchant_id: "mch_quick",
  display_name: "Nukkad Quick",
  vertical: "quick_commerce",
  min_margin_bps: 1_500,
  max_discount_bps: 2_000,
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples"],
};

const GHEE: CatalogItem = {
  sku: "QC_GHEE_1L",
  merchant_id: "mch_quick",
  title: "Pure Cow Ghee 1L",
  category: "staples",
  unit: "tin",
  list_paise: rupees(900),
  cost_paise: rupees(700),
  stock: 1,
  moq: 1,
};

function mandateOf(over: Partial<ReserveMandate> = {}): ReserveMandate {
  const now = Date.now();
  return {
    mandate_id: "mnd_test",
    principal_id: "prn_test",
    agent_id: "agt_buyer",
    agent_public_key: AGENT_KEYS.publicKey,
    vertical: "quick_commerce",
    reserved_paise: rupees(5_000),
    max_per_txn_paise: rupees(2_000),
    max_txn_count: 8,
    requires_human_approval_above_paise: rupees(1_500),
    scope: { merchant_allowlist: ["mch_quick"], category_allowlist: ["staples"] },
    human_present: false,
    not_before: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 86_400_000).toISOString(),
    nonce: "test",
    ...over,
  };
}

function harness(items: CatalogItem[] = [GHEE]) {
  const store = Store.open(":memory:");
  const sakshi = Sakshi.open(":memory:");
  const rail = new FixtureRail({ now: () => 1_700_000_000_000 });
  const mandate = mandateOf();

  store.putMerchant(PROFILE);
  for (const i of items) store.putItem(i);
  store.putPrincipal(mandate.principal_id, KEYS.publicKey);
  store.putMandate({
    mandate,
    signature: signValue(mandate, KEYS.privateKey),
    public_key: KEYS.publicKey,
  });

  return { store, sakshi, rail, engine: new Engine({ store, sakshi, rail }) };
}

function offerOf(sku: string, qty: number, unit: number): Proposal {
  return {
    merchant_id: "mch_quick",
    lines: [{ sku, qty, offer_unit_paise: paise(unit) }],
    quoted_total_paise: paise(unit * qty),
    rationale: "test",
  };
}

const simulateWith = (rail: FixtureRail, vpa: string) => async (orderId: string) => {
  const sim = await rail.simulateCheckout(orderId, vpa);
  return {
    paymentId: sim.payment.id,
    signature: sim.signature,
    failed: sim.payment.status === "failed",
  };
};

/* ------------------------------------------------------------------ F2 --- */

describe("F2: a payment that declines", () => {
  it("retries a bounded number of times, then hands control to a human", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_f2",
      proposal: offerOf("QC_GHEE_1L", 1, rupees(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error(`expected AUTHORISED, got ${authorised.kind}`);

    const result = await h.engine.settle({
      order_id: authorised.order_id,
      token_id: authorised.token.token_id,
      session_id: "ses_f2",
      vpa: TEST_VPA_FAILURE,
      simulate: simulateWith(h.rail, TEST_VPA_FAILURE),
    });

    expect(result.kind).toBe("FAILED_FALLBACK_LINK");
    if (result.kind !== "FAILED_FALLBACK_LINK") throw new Error("unreachable");

    // Bounded: the default budget is 2 retries, so 3 attempts and no more.
    expect(result.attempts).toBe(3);
    expect(result.link_url).toContain("rzp.io");

    const events = h.sakshi.read().map((e) => e.event_type);
    expect(events.filter((e) => e === "PAYMENT_FAILED").length).toBe(3);
    expect(events).toContain("RETRY_BOUNDED");
    expect(events).toContain("STEPUP_ISSUED");
    h.store.close();
  });

  it("does not draw down the envelope for a payment that never captured", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_f2b",
      proposal: offerOf("QC_GHEE_1L", 1, rupees(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error("expected AUTHORISED");

    await h.engine.settle({
      order_id: authorised.order_id,
      token_id: authorised.token.token_id,
      session_id: "ses_f2b",
      vpa: TEST_VPA_FAILURE,
      simulate: simulateWith(h.rail, TEST_VPA_FAILURE),
    });

    expect(h.store.getMandateState("mnd_test")?.consumed_paise).toBe(0);
    h.store.close();
  });
});

/* ------------------------------------------------------------------ F3 --- */

describe("F3: captured, then unshippable", () => {
  it("refunds, restores the stock, and restores the envelope", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_f3",
      proposal: offerOf("QC_GHEE_1L", 1, rupees(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error("expected AUTHORISED");

    const settled = await h.engine.settle({
      order_id: authorised.order_id,
      token_id: authorised.token.token_id,
      session_id: "ses_f3",
      vpa: TEST_VPA_SUCCESS,
      simulate: simulateWith(h.rail, TEST_VPA_SUCCESS),
    });
    if (settled.kind !== "CAPTURED") throw new Error("expected CAPTURED");

    // Money moved and the last tin is spoken for.
    expect(h.store.getMandateState("mnd_test")?.consumed_paise).toBe(rupees(880));
    expect(h.store.getItem("QC_GHEE_1L")?.stock).toBe(0);

    const compensated = await h.engine.compensate({
      order_id: authorised.order_id,
      payment_id: settled.payment_id,
      session_id: "ses_f3",
      reason: "stock unavailable after capture",
      restore: [{ sku: "QC_GHEE_1L", qty: 1 }],
    });

    expect(compensated.kind).toBe("REFUNDED");
    // The principal is exactly where they started.
    expect(h.store.getMandateState("mnd_test")?.consumed_paise).toBe(0);
    expect(h.store.getItem("QC_GHEE_1L")?.stock).toBe(1);
    expect(h.store.getOrder(authorised.order_id)?.status).toBe("refunded");

    const events = h.sakshi.read().map((e) => e.event_type);
    expect(events).toContain("AUTO_REFUND_ISSUED");
    h.store.close();
  });

  it("records the cart lines on the order, so compensation knows what to restore", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_lines",
      proposal: offerOf("QC_GHEE_1L", 1, rupees(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error("expected AUTHORISED");

    const created = h.sakshi.byEventType("ORDER_CREATED")[0];
    const lines = (
      created?.detail as
        | { lines?: { sku: string; qty: number; line_total_paise: number }[] }
        | undefined
    )?.lines;

    // The line total rides along too: split settlement divides a captured
    // payment by what each supplier actually sold, and the orders table keeps
    // only a hash of the cart.
    expect(lines).toEqual([{ sku: "QC_GHEE_1L", qty: 1, line_total_paise: rupees(880) }]);
    h.store.close();
  });

  it("the inventory race itself is settled before anyone pays", async () => {
    const h = harness();

    const first = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_race_a",
      proposal: offerOf("QC_GHEE_1L", 1, rupees(880)),
    });
    const second = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_race_b",
      proposal: offerOf("QC_GHEE_1L", 1, rupees(880)),
    });

    expect(first.kind).toBe("AUTHORISED");
    expect(second.kind).toBe("DENIED");
    if (second.kind !== "DENIED") throw new Error("unreachable");
    expect(second.rule_id).toBe("INVENTORY.INSUFFICIENT");

    // Exactly one order exists, and the loser made no rail call.
    expect(h.sakshi.byEventType("ORDER_CREATED").length).toBe(1);
    expect(h.sakshi.byEventType("INVENTORY_CONFLICT").length).toBe(1);
    h.store.close();
  });
});

/* ------------------------------------------------------------- F4 / F5 --- */

/**
 * The webhook path, at the Engine.
 *
 * `WebhookGate` already had unit tests for signature and dedupe. What was never
 * covered is the half that matters to an order: an accepted event changing
 * payment state, a rejected one changing nothing, and a late event failing to
 * wind a captured payment backwards.
 */

/** A Razorpay-shaped delivery for a payment on a known order. */
function deliveryOf(
  rail: FixtureRail,
  args: { paymentId: string; orderId: string; status: "authorized" | "captured"; amount: number },
): { body: string; signature: string } {
  const body = JSON.stringify({
    entity: "event",
    account_id: "acc_FIXTURE",
    event: args.status === "captured" ? "payment.captured" : "payment.authorized",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: args.paymentId,
          entity: "payment",
          amount: args.amount,
          currency: "INR",
          status: args.status,
          order_id: args.orderId,
          method: "upi",
          captured: args.status === "captured",
          created_at: 1_700_000_000,
        },
      },
    },
    created_at: 1_700_000_000,
  });
  return { body, signature: rail.signWebhook(body) };
}

/** An allowed, unpaid order: payment state starts at `created`. */
async function orderFor(h: ReturnType<typeof harness>): Promise<string> {
  const result = await h.engine.propose({
    mandate_id: "mnd_test",
    proposal: offerOf("QC_GHEE_1L", 1, rupees(900)),
    session_id: "sess_webhook",
  });
  if (result.kind === "DENIED") throw new Error("setup failed: the gate denied the fixture cart");
  return result.order_id;
}

describe("F4: a forged webhook", () => {
  it("is rejected and leaves payment state untouched", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const genuine = deliveryOf(h.rail, {
      paymentId: "pay_forge",
      orderId,
      status: "captured",
      amount: rupees(900),
    });

    const verdict = h.engine.handleWebhook(genuine.body, {
      "x-razorpay-signature": `${genuine.signature.slice(0, -2)}00`,
      "x-razorpay-event-id": "evt_forged",
    });

    expect(verdict.kind).toBe("REJECTED_SIGNATURE");
    expect(h.store.getOrder(orderId)?.payment_status).toBe("created");
    expect(h.sakshi.byEventType("WEBHOOK_REJECTED")).toHaveLength(1);
    expect(h.sakshi.byEventType("WEBHOOK_ACCEPTED")).toHaveLength(0);
  });

  it("does not consume the event id, so the genuine delivery still processes", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const genuine = deliveryOf(h.rail, {
      paymentId: "pay_forge",
      orderId,
      status: "captured",
      amount: rupees(900),
    });

    h.engine.handleWebhook(`${genuine.body} `, {
      "x-razorpay-signature": genuine.signature,
      "x-razorpay-event-id": "evt_same",
    });
    const accepted = h.engine.handleWebhook(genuine.body, {
      "x-razorpay-signature": genuine.signature,
      "x-razorpay-event-id": "evt_same",
    });

    expect(accepted.kind).toBe("ACCEPTED");
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");
  });
});

describe("F5: out-of-order and duplicate webhooks", () => {
  it("converges when captured arrives before authorized", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const args = { paymentId: "pay_ooo", orderId, amount: rupees(900) };

    const captured = deliveryOf(h.rail, { ...args, status: "captured" });
    h.engine.handleWebhook(captured.body, {
      "x-razorpay-signature": captured.signature,
      "x-razorpay-event-id": "evt_captured",
    });
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");

    const late = deliveryOf(h.rail, { ...args, status: "authorized" });
    const verdict = h.engine.handleWebhook(late.body, {
      "x-razorpay-signature": late.signature,
      "x-razorpay-event-id": "evt_authorized",
    });

    // Accepted as a genuine event, and then deliberately not applied.
    expect(verdict.kind).toBe("ACCEPTED");
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");
  });

  it("treats a replayed event id as a no-op", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const captured = deliveryOf(h.rail, {
      paymentId: "pay_dupe",
      orderId,
      status: "captured",
      amount: rupees(900),
    });
    const headers = {
      "x-razorpay-signature": captured.signature,
      "x-razorpay-event-id": "evt_once",
    };

    expect(h.engine.handleWebhook(captured.body, headers).kind).toBe("ACCEPTED");
    expect(h.engine.handleWebhook(captured.body, headers).kind).toBe("DUPLICATE");
    expect(h.sakshi.byEventType("WEBHOOK_DEDUPED")).toHaveLength(1);
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");
  });

  it("records but does not apply an event for an order it does not have", () => {
    const h = harness();
    const stranger = deliveryOf(h.rail, {
      paymentId: "pay_stranger",
      orderId: "order_not_ours",
      status: "captured",
      amount: rupees(100),
    });

    const verdict = h.engine.handleWebhook(stranger.body, {
      "x-razorpay-signature": stranger.signature,
      "x-razorpay-event-id": "evt_stranger",
    });

    expect(verdict.kind).toBe("ACCEPTED");
    const entry = h.sakshi.byEventType("WEBHOOK_ACCEPTED")[0];
    expect((entry?.detail as { applied?: boolean } | undefined)?.applied).toBe(false);
  });
});


/* --------------------------------------------------------- Route (B2B) --- */

/**
 * Split settlement.
 *
 * The B2B vertical sells other people's goods: one cart, one payment, several
 * suppliers. These tests are about the property that makes that safe to
 * automate -- the transfers sum to exactly what was captured, every time, with
 * the platform's commission taken off the top rather than out of a supplier.
 */

const B2B_PROFILE: MerchantProfile = {
  merchant_id: "mch_bulk",
  display_name: "Annapurna Wholesale",
  vertical: "b2b_procurement",
  min_margin_bps: 800,
  max_discount_bps: 3_500,
  levers: ["bulk_tier", "substitute"],
  category_taxonomy: ["staples", "packaging"],
  settlement: { mode: "route", commission_bps: 200, commission_account_id: "acc_PLATFORM" },
};

const WS_RICE: CatalogItem = {
  sku: "WS_RICE_25KG",
  merchant_id: "mch_bulk",
  title: "Sona Masoori Rice 25kg",
  category: "staples",
  unit: "sack",
  list_paise: rupees(2_800),
  cost_paise: rupees(2_200),
  stock: 50,
  moq: 1,
  supplier_account_id: "acc_GRAINS",
};

const WS_CUPS: CatalogItem = {
  sku: "WS_CUPS_1000",
  merchant_id: "mch_bulk",
  title: "Paper Cups (1000 ct)",
  category: "packaging",
  unit: "carton",
  list_paise: rupees(1_600),
  cost_paise: rupees(1_250),
  stock: 50,
  moq: 1,
  supplier_account_id: "acc_PACKAGING",
};

function b2bHarness() {
  const store = Store.open(":memory:");
  const sakshi = Sakshi.open(":memory:");
  const rail = new FixtureRail({ now: () => 1_700_000_000_000 });
  const mandate = mandateOf({
    mandate_id: "mnd_b2b",
    vertical: "b2b_procurement",
    reserved_paise: rupees(500_000),
    max_per_txn_paise: rupees(200_000),
    requires_human_approval_above_paise: rupees(200_000),
    scope: { merchant_allowlist: ["mch_bulk"], category_allowlist: ["staples", "packaging"] },
  });

  store.putMerchant(B2B_PROFILE);
  for (const i of [WS_RICE, WS_CUPS]) store.putItem(i);
  store.putPrincipal(mandate.principal_id, KEYS.publicKey);
  store.putMandate({
    mandate,
    signature: signValue(mandate, KEYS.privateKey),
    public_key: KEYS.publicKey,
  });

  return { store, sakshi, rail, engine: new Engine({ store, sakshi, rail }) };
}

/** A two-supplier cart: rice from the grain supplier, cups from packaging. */
function mixedCart(): Proposal {
  return {
    merchant_id: "mch_bulk",
    lines: [
      { sku: "WS_RICE_25KG", qty: 3, offer_unit_paise: rupees(2_800) },
      { sku: "WS_CUPS_1000", qty: 2, offer_unit_paise: rupees(1_600) },
    ],
    quoted_total_paise: rupees(3 * 2_800 + 2 * 1_600),
    rationale: "test",
  };
}

describe("Route: splitting a captured payment across suppliers", () => {
  it("transfers sum to exactly the captured amount", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error(`expected AUTHORISED, got ${result.kind}`);

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
      simulate: simulateWith(h.rail, TEST_VPA_SUCCESS),
    });
    if (settled.kind !== "CAPTURED") throw new Error(`expected CAPTURED, got ${settled.kind}`);

    const transfers = await h.rail.fetchTransfers(settled.payment_id);
    const total = transfers.reduce((a, t) => a + t.amount, 0);
    expect(total).toBe(settled.amount);
    expect(transfers.map((t) => t.recipient).sort()).toEqual([
      "acc_GRAINS",
      "acc_PACKAGING",
      "acc_PLATFORM",
    ]);
  });

  it("takes the commission off the top, not out of a supplier's share", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
      simulate: simulateWith(h.rail, TEST_VPA_SUCCESS),
    });
    if (settled.kind !== "CAPTURED") throw new Error("setup failed");

    const transfers = await h.rail.fetchTransfers(settled.payment_id);
    const commission = transfers.find((t) => t.recipient === "acc_PLATFORM");
    expect(commission?.amount).toBe(Math.floor((settled.amount * 200) / 10_000));

    // Suppliers divide what is left in proportion to what each actually sold.
    const suppliers = transfers.filter((t) => t.recipient !== "acc_PLATFORM");
    const distributable = settled.amount - (commission?.amount ?? 0);
    expect(suppliers.reduce((a, t) => a + t.amount, 0)).toBe(distributable);

    const grains = transfers.find((t) => t.recipient === "acc_GRAINS")?.amount ?? 0;
    const packaging = transfers.find((t) => t.recipient === "acc_PACKAGING")?.amount ?? 0;
    expect(grains).toBeGreaterThan(packaging);
  });

  it("records the split in Sakshi with every leg", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
      simulate: simulateWith(h.rail, TEST_VPA_SUCCESS),
    });

    const entries = h.sakshi.byEventType("SETTLEMENT_SPLIT");
    expect(entries).toHaveLength(1);
    const detail = entries[0]?.detail as {
      legs?: { account: string; amount_paise: number }[];
      commission_paise?: number;
      captured_paise?: number;
    };
    expect(detail.legs).toHaveLength(3);
    expect(detail.legs?.reduce((a, l) => a + l.amount_paise, 0)).toBe(detail.captured_paise);
  });

  it("does not split a merchant's own inventory", async () => {
    // Quick-commerce sells what it owns: no line names a supplier, no profile
    // names a settlement, so nothing transfers. Same code path, different data.
    const h = harness();
    const result = await h.engine.propose({
      mandate_id: "mnd_test",
      proposal: offerOf("QC_GHEE_1L", 1, rupees(900)),
      session_id: "sess_own",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_own",
      simulate: simulateWith(h.rail, TEST_VPA_SUCCESS),
    });
    if (settled.kind !== "CAPTURED") throw new Error("setup failed");

    expect(await h.rail.fetchTransfers(settled.payment_id)).toEqual([]);
    expect(h.sakshi.byEventType("SETTLEMENT_SPLIT")).toHaveLength(0);
  });

  it("keeps the capture when a transfer fails, and says so in the ledger", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    // The rail refuses every split from here on.
    h.rail.createTransfers = async () => {
      throw new Error("linked account is not activated");
    };

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
      simulate: simulateWith(h.rail, TEST_VPA_SUCCESS),
    });

    // The buyer paid and the goods are theirs; a stuck payout is an operator's
    // problem, not a reason to reverse a payment that succeeded.
    expect(settled.kind).toBe("CAPTURED");
    const entry = h.sakshi.byEventType("SETTLEMENT_SPLIT")[0];
    expect((entry?.detail as { failed?: boolean } | undefined)?.failed).toBe(true);
  });
});
