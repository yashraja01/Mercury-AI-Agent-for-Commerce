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
import { lowestLegalUnit } from "@mercury/dwaar";
import { FixtureRail } from "@mercury/rail";
import { Sakshi } from "@mercury/sakshi";
import { Store } from "@mercury/store";
import { Engine } from "./engine.js";
import { gateVia } from "./bridge.js";
import type { NegotiatorContext } from "./negotiator.js";
import { ScriptedRevenueAgent, inferCart } from "./scripted-agent.js";
import { personaFor, systemPrompt } from "./prompts.js";
import { priceFloor, quoteTotal, revenueTools, searchCatalog } from "./tools.js";

/**
 * The agent, end to end, with no API key and no network.
 *
 * Everything here runs the real gate, the real ledger and the real (fixture)
 * rail. Only the model's judgement is substituted, by `ScriptedRevenueAgent` --
 * which calls the same tool implementations Claude calls.
 */

/* ------------------------------------------------------------- fixtures --- */

const KEYS = generateKeyPair();

const QUICK: MerchantProfile = {
  merchant_id: "mch_quick",
  display_name: "Nukkad Quick",
  vertical: "quick_commerce",
  min_margin_bps: 1_500,
  max_discount_bps: 2_000,
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples", "beverages"],
};

const BULK: MerchantProfile = {
  merchant_id: "mch_bulk",
  display_name: "Annapurna Wholesale",
  vertical: "b2b_procurement",
  min_margin_bps: 800,
  max_discount_bps: 3_500,
  levers: ["bulk_tier", "credit_terms"],
  category_taxonomy: ["staples"],
};

function item(over: Partial<CatalogItem> & { sku: string }): CatalogItem {
  return {
    merchant_id: "mch_quick",
    title: "Sona Masoori Rice 5kg",
    category: "staples",
    unit: "bag",
    list_paise: rupees(600),
    cost_paise: rupees(400),
    stock: 40,
    moq: 1,
    ...over,
  };
}

const QUICK_ITEMS: CatalogItem[] = [
  item({ sku: "QC_RICE_5KG" }),
  item({
    sku: "QC_TEA_250G",
    title: "Assam Tea 250g",
    category: "beverages",
    unit: "pack",
    list_paise: rupees(250),
    cost_paise: rupees(150),
    stock: 100,
  }),
];

const BULK_ITEMS: CatalogItem[] = [
  item({
    sku: "WS_RICE_25KG",
    merchant_id: "mch_bulk",
    title: "Sona Masoori Rice 25kg",
    unit: "sack",
    list_paise: rupees(2_800),
    cost_paise: rupees(2_200),
    stock: 200,
    moq: 4,
  }),
];

function mandateOf(over: Partial<ReserveMandate> = {}): ReserveMandate {
  const now = Date.now();
  return {
    mandate_id: "mnd_test",
    principal_id: "prn_test",
    agent_id: "agt_buyer",
    vertical: "quick_commerce",
    reserved_paise: rupees(5_000),
    max_per_txn_paise: rupees(2_000),
    max_txn_count: 8,
    requires_human_approval_above_paise: rupees(1_500),
    scope: {
      merchant_allowlist: ["mch_quick", "mch_bulk"],
      category_allowlist: ["staples", "beverages"],
    },
    human_present: false,
    not_before: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 86_400_000).toISOString(),
    nonce: "test",
    ...over,
  };
}

interface Harness {
  engine: Engine;
  store: Store;
  sakshi: Sakshi;
  rail: FixtureRail;
  ctx: (profile: MerchantProfile, submit: NegotiatorContext["submit"]) => NegotiatorContext;
  catalog: ReadonlyMap<string, CatalogItem>;
}

function harness(
  profile: MerchantProfile = QUICK,
  items: CatalogItem[] = QUICK_ITEMS,
  mandate: ReserveMandate = mandateOf(),
): Harness {
  const store = Store.open(":memory:");
  const sakshi = Sakshi.open(":memory:");
  const rail = new FixtureRail({ now: () => 1_700_000_000_000 });

  store.putMerchant(profile);
  for (const i of items) store.putItem(i);
  store.putPrincipal(mandate.principal_id, KEYS.publicKey);
  store.putMandate({
    mandate,
    signature: signValue(mandate, KEYS.privateKey),
    public_key: KEYS.publicKey,
  });

  const engine = new Engine({ store, sakshi, rail });
  const catalog = store.catalogFor(profile.merchant_id);

  return {
    engine,
    store,
    sakshi,
    rail,
    catalog,
    ctx: (p, submit) => ({
      profile: p,
      catalog: store.catalogFor(p.merchant_id),
      persona: personaFor(p.vertical),
      submit,
      maxRounds: 3,
    }),
  };
}

/* ------------------------------------------------------------- the tools --- */

describe("the shared tool surface", () => {
  it("never exposes landed cost to the agent", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));
    const rows = searchCatalog(ctx, {});

    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("cost_paise");
      expect(JSON.stringify(row)).not.toContain("40000");
    }
    h.store.close();
  });

  it("reports a floor the agent can legally offer at", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));
    const [floor] = priceFloor(ctx, ["QC_RICE_5KG"]);

    expect(floor).toBeDefined();
    const rice = h.catalog.get("QC_RICE_5KG");
    expect(rice).toBeDefined();
    if (rice === undefined || floor === undefined) throw new Error("unreachable");
    expect(floor.lowest_legal_unit_paise).toBe(lowestLegalUnit(rice, QUICK));
    // 15% over a Rs 400 cost is Rs 460; the 20% discount ceiling allows Rs 480.
    expect(floor.lowest_legal_unit_paise).toBe(rupees(480));
    h.store.close();
  });

  it("declares every tool strict, with no additional properties", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));
    const tools = revenueTools(ctx, {
      record: () => undefined,
      settled: () => false,
      rounds: () => 0,
    });

    expect(tools.map((t) => t.name).sort()).toEqual([
      "price_floor",
      "search_catalog",
      "submit_offer",
    ]);
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      const schema = (tool as unknown as { input_schema: Record<string, unknown> }).input_schema;
      expect(schema["additionalProperties"]).toBe(false);
    }
    h.store.close();
  });

  it("serves both verticals from one tool set", () => {
    const quick = harness();
    const bulk = harness(BULK, BULK_ITEMS);
    const noop: NegotiatorContext["submit"] = async () => ({
      outcome: "DENY",
      rule_ids: [],
      messages: [],
    });

    const a = revenueTools(quick.ctx(QUICK, noop), {
      record: () => undefined,
      settled: () => false,
      rounds: () => 0,
    });
    const b = revenueTools(bulk.ctx(BULK, noop), {
      record: () => undefined,
      settled: () => false,
      rounds: () => 0,
    });

    // Same names, same schemas. Only the data behind them differs.
    const schemas = (tools: typeof a): string[] =>
      tools.map((t) => JSON.stringify((t as { input_schema: unknown }).input_schema));

    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
    expect(schemas(a)).toEqual(schemas(b));
    quick.store.close();
    bulk.store.close();
  });
});

/* --------------------------------------------------------------- prompts --- */

describe("prompts", () => {
  it("assembles shared rules plus a per-vertical persona", () => {
    const quick = systemPrompt(personaFor("quick_commerce"));
    const b2b = systemPrompt(personaFor("b2b_procurement"));

    expect(quick).toContain("You propose. Dwaar disposes.");
    expect(b2b).toContain("You propose. Dwaar disposes.");
    expect(quick).toContain("Nukkad Quick");
    expect(b2b).toContain("Annapurna Wholesale");
    expect(quick).not.toBe(b2b);

    // The shared half must be byte-identical, or the cache prefix splits.
    const shared = quick.slice(0, quick.indexOf("\n\n---\n\n"));
    expect(b2b.startsWith(shared)).toBe(true);
  });
});

/* ---------------------------------------------------------- negotiation --- */

describe("the Revenue Agent", () => {
  it("closes a normal basket and creates exactly one order", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_1" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_RICE_5KG", qty: 2 }],
    });

    const result = await agent.negotiate({
      session_id: "ses_1",
      buyer_message: "Two bags of rice please.",
    });

    expect(result.settled).toBeDefined();
    expect(result.rounds.length).toBe(1);
    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(bridge.results().filter((r) => r.kind !== "DENIED").length).toBe(1);
    expect(h.sakshi.byEventType("ORDER_CREATED").length).toBe(1);
    h.store.close();
  });

  it("charges Dwaar's total, never the agent's", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_2" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_RICE_5KG", qty: 2 }],
    });

    await agent.negotiate({ session_id: "ses_2", buyer_message: "rice" });

    const accepted = bridge.accepted();
    expect(accepted?.kind).toBe("AUTHORISED");
    if (accepted === undefined || accepted.kind === "DENIED") throw new Error("unreachable");
    const order = h.store.getOrder(accepted.order_id);
    expect(order?.amount).toBe(accepted.decision.computed_paise);
    expect(order?.amount).toBe(accepted.cart.total_paise);
    h.store.close();
  });

  /* F1 -- the failure this milestone exists to make reachable. */
  it("F1: a below-floor offer is denied, and the agent re-quotes legally", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_f1" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_RICE_5KG", qty: 2 }],
      // The buyer pushed, and the agent caved by Rs 50 a bag.
      underCutPaise: rupees(50),
    });

    const result = await agent.negotiate({
      session_id: "ses_f1",
      buyer_message: "Rs 430 a bag or I go elsewhere.",
    });

    expect(result.rounds.length).toBe(2);
    const [denied, allowed] = result.rounds;
    expect(denied?.feedback.outcome).toBe("DENY");
    expect(denied?.feedback.rule_ids).toContain("MARGIN.FLOOR_BREACH");
    expect(allowed?.feedback.outcome).toBe("ALLOW");

    // The re-quote lands exactly on the floor, not above it.
    const rice = h.catalog.get("QC_RICE_5KG");
    if (rice === undefined) throw new Error("unreachable");
    expect(allowed?.proposal.lines[0]?.offer_unit_paise).toBe(lowestLegalUnit(rice, QUICK));

    // And the denial made no rail call at all.
    expect(h.sakshi.byEventType("ORDER_CREATED").length).toBe(1);
    expect(h.sakshi.byEventType("MANDATE_BREACH_BLOCKED").length).toBe(1);
    h.store.close();
  });

  /* Drift: the agent's arithmetic disagreeing with Dwaar's. */
  it("F1: a quoted total that does not match the lines is denied as drift", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_drift" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_RICE_5KG", qty: 2 }],
      driftPaise: 1,
      reQuote: false,
    });

    const result = await agent.negotiate({ session_id: "ses_drift", buyer_message: "rice" });

    expect(result.settled).toBeUndefined();
    expect(result.rounds[0]?.feedback.rule_ids).toContain("DRIFT.AMOUNT_MISMATCH");
    expect(h.sakshi.byEventType("ORDER_CREATED").length).toBe(0);
    expect(h.sakshi.byEventType("DRIFT_BLOCKED").length).toBeGreaterThan(0);
    h.store.close();
  });

  it("routes a large basket to a human step-up rather than paying it", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_stepup" });
    // 3 bags at list is Rs 1,800: over the Rs 1,500 approval threshold, but
    // still inside the Rs 2,000 per-transaction cap -- so it is a step-up, not
    // a denial.
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_RICE_5KG", qty: 3 }],
      discountBps: 0,
    });

    const result = await agent.negotiate({ session_id: "ses_stepup", buyer_message: "three bags" });

    expect(result.settled?.feedback.outcome).toBe("ALLOW_WITH_STEPUP");
    expect(result.reply).toContain("approval link");
    expect(h.sakshi.byEventType("STEPUP_ISSUED").length).toBe(1);
    h.store.close();
  });

  it("F6: a basket beyond the envelope is denied with zero rail calls", async () => {
    const h = harness(QUICK, QUICK_ITEMS, mandateOf({ max_per_txn_paise: rupees(100) }));
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_f6" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_RICE_5KG", qty: 2 }],
    });

    const result = await agent.negotiate({ session_id: "ses_f6", buyer_message: "rice" });

    expect(result.settled).toBeUndefined();
    expect(result.rounds.every((r) => r.feedback.outcome === "DENY")).toBe(true);
    expect(h.sakshi.byEventType("ORDER_CREATED").length).toBe(0);
    expect(h.sakshi.byEventType("MANDATE_BREACH_BLOCKED").length).toBeGreaterThan(0);
    h.store.close();
  });

  it("the same agent code serves a B2B merchant with different economics", async () => {
    const h = harness(
      BULK,
      BULK_ITEMS,
      mandateOf({
        vertical: "b2b_procurement",
        reserved_paise: rupees(300_000),
        max_per_txn_paise: rupees(150_000),
        requires_human_approval_above_paise: rupees(200_000),
        human_present: true,
      }),
    );
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_b2b" });
    const agent = new ScriptedRevenueAgent(h.ctx(BULK, bridge.submit), {
      want: [{ sku: "WS_RICE_25KG", qty: 10 }],
      // 30% off list is legal here and would be a hard DENY at the quick-commerce merchant.
      discountBps: 3_000,
    });

    const result = await agent.negotiate({
      session_id: "ses_b2b",
      buyer_message: "Ten sacks of 25kg rice, best price.",
    });

    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(result.rounds.length).toBe(1);
    h.store.close();
  });

  it("stops after the round limit instead of negotiating forever", async () => {
    const h = harness();
    let calls = 0;
    const ctx = h.ctx(QUICK, async () => {
      calls += 1;
      return {
        outcome: "DENY",
        rule_ids: ["MARGIN.FLOOR_BREACH"],
        messages: ["MARGIN.FLOOR_BREACH: below floor (observed 1, limit 2)"],
      };
    });
    // Always re-quotes, always denied: the loop must still terminate.
    const agent = new ScriptedRevenueAgent(
      { ...ctx, maxRounds: 3 },
      { want: [{ sku: "QC_RICE_5KG", qty: 1 }], underCutPaise: rupees(100) },
    );

    const result = await agent.negotiate({ session_id: "ses_loop", buyer_message: "rice" });

    expect(calls).toBeLessThanOrEqual(3);
    expect(result.settled).toBeUndefined();
    // The buyer is told why in plain words; the rule id stays in the ledger.
    expect(result.reply).toContain("lowest we can do");
    expect(result.reply).not.toContain("MARGIN.FLOOR_BREACH");
    h.store.close();
  });

  it("says so rather than inventing a SKU it does not stock", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_none" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {});

    const result = await agent.negotiate({
      session_id: "ses_none",
      buyer_message: "Do you sell motorcycle tyres?",
    });

    expect(result.rounds.length).toBe(0);
    expect(result.reply).toContain("do not stock");
    h.store.close();
  });
});

/* ------------------------------------------------------ cart inference --- */

describe("cart inference", () => {
  it("reads a quantity and a product out of plain text", () => {
    const h = harness(BULK, BULK_ITEMS);
    const ctx = h.ctx(BULK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));

    expect(inferCart(ctx, "I need 10 sacks of Sona Masoori rice")).toEqual([
      { sku: "WS_RICE_25KG", qty: 10 },
    ]);
    h.store.close();
  });

  it("never proposes a quantity below the SKU minimum order quantity", () => {
    const h = harness(BULK, BULK_ITEMS);
    const ctx = h.ctx(BULK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));

    const cart = inferCart(ctx, "just 1 sack of rice");
    expect(cart[0]?.qty).toBeGreaterThanOrEqual(4);
    h.store.close();
  });
});

/* ------------------------------------------------------------ arithmetic --- */

describe("quoteTotal", () => {
  it("is the sum Dwaar checks the agent against", () => {
    const lines: Proposal["lines"] = [
      { sku: "A", qty: 3, offer_unit_paise: paise(1_999) },
      { sku: "B", qty: 2, offer_unit_paise: paise(500) },
    ];
    expect(quoteTotal(lines)).toBe(3 * 1_999 + 2 * 500);
  });
});
