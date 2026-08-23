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
    const lines = (created?.detail as { lines?: { sku: string; qty: number }[] } | undefined)?.lines;

    expect(lines).toEqual([{ sku: "QC_GHEE_1L", qty: 1 }]);
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
