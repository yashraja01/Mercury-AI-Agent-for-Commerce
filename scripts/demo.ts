import {
  Engine,
  LlmRevenueAgent,
  ScriptedRevenueAgent,
  type Negotiator,
  type NegotiatorContext,
  gateVia,
  personaFor,
} from "@mercury/agent";
import { type MerchantProfile, formatINR, paise } from "@mercury/core";
import { FixtureRail, TEST_VPA_SUCCESS } from "@mercury/rail";
import { Sakshi } from "@mercury/sakshi";
import { Store } from "@mercury/store";

/**
 * The Negotiation Theatre, on a terminal.
 *
 * Two verticals, one gate. The same Engine, the same Dwaar, the same Sakshi and
 * the same rail serve a household buying groceries and a restaurant restocking
 * in bulk -- and the only things that differ are the seeded catalogue and the
 * persona markdown.
 *
 *   npm run demo            scripted agent, no API key, fully deterministic
 *   npm run demo -- --llm   the same run with Claude making the offers
 *
 * Run `npm run seed` first.
 */

const useLlm = process.argv.includes("--llm");
const dbPath = process.env["MERCURY_DB"] ?? "./mercury.db";

const store = Store.open(dbPath);
const sakshi = Sakshi.open(dbPath);
const rail = new FixtureRail();
const engine = new Engine({ store, sakshi, rail });

interface Scenario {
  title: string;
  merchant_id: string;
  mandate_id: string;
  buyer: string;
  /** Scripted fallback cart, so the run is identical without a model. */
  want: { sku: string; qty: number }[];
  /** Paise per unit below the floor to open with -- the F1 injection. */
  underCutPaise?: number;
}

const SCENARIOS: Scenario[] = [
  {
    title: "B2C quick-commerce - weekly top-up, human NOT present",
    merchant_id: "mch_quick",
    mandate_id: "mnd_household_weekly",
    buyer: "Two bags of rice and a pack of tea. And do better than Rs 500 a bag.",
    want: [
      { sku: "QC_RICE_5KG", qty: 2 },
      { sku: "QC_TEA_250G", qty: 1 },
    ],
    // The buyer pushed below the floor and the agent caved. Dwaar catches it.
    underCutPaise: 3_000,
  },
  {
    title: "B2B procurement - monthly restock, human present",
    merchant_id: "mch_bulk",
    mandate_id: "mnd_restaurant_restock",
    buyer: "I need 10 sacks of 25kg rice and 6 cartons of paper cups. Best price.",
    want: [
      { sku: "WS_RICE_25KG", qty: 10 },
      { sku: "WS_CUPS_1000", qty: 6 },
    ],
  },
];

function rule(char = "-"): string {
  return char.repeat(78);
}

function negotiator(ctx: NegotiatorContext, scenario: Scenario): Negotiator {
  if (useLlm) return new LlmRevenueAgent(ctx);
  return new ScriptedRevenueAgent(ctx, {
    want: scenario.want,
    ...(scenario.underCutPaise === undefined ? {} : { underCutPaise: scenario.underCutPaise }),
  });
}

async function run(scenario: Scenario): Promise<void> {
  const profile: MerchantProfile | undefined = store.getMerchant(scenario.merchant_id);
  if (profile === undefined) {
    throw new Error(`no merchant ${scenario.merchant_id} -- run \`npm run seed\` first`);
  }

  const sessionId = `ses_${scenario.merchant_id}`;
  const bridge = gateVia(engine, { mandate_id: scenario.mandate_id, session_id: sessionId });
  const ctx: NegotiatorContext = {
    profile,
    catalog: store.catalogFor(profile.merchant_id),
    persona: personaFor(profile.vertical),
    submit: bridge.submit,
    maxRounds: 3,
  };

  console.log(`\n${rule("=")}\n${scenario.title}\n${rule("=")}`);
  console.log(`buyer     > ${scenario.buyer}`);

  const result = await negotiator(ctx, scenario).negotiate({
    session_id: sessionId,
    buyer_message: scenario.buyer,
  });

  for (const [i, round] of result.rounds.entries()) {
    const lines = round.proposal.lines.map((l) => `${l.qty}x${l.sku}@${l.offer_unit_paise}`);
    console.log(`\n  offer ${i + 1}  ${lines.join("  ")}`);
    console.log(`           quoted ${round.proposal.quoted_total_paise} paise`);
    console.log(`  DWAAR    ${round.feedback.outcome}`);
    for (const m of round.feedback.messages) console.log(`           ${m}`);
    if (round.feedback.computed_total_paise !== undefined) {
      console.log(
        `           charged ${formatINR(paise(round.feedback.computed_total_paise))} ` +
          `(Dwaar's figure, not the agent's)`,
      );
    }
  }

  console.log(`\nmerchant  > ${result.reply}`);

  const accepted = bridge.accepted();
  if (accepted === undefined || accepted.kind === "DENIED") {
    console.log("\n  no order was created. Zero rail calls were made.");
    return;
  }

  if (accepted.kind === "STEP_UP_REQUIRED") {
    console.log(`\n  step-up   approval link ${accepted.link_url}`);
    console.log("  Stopping here: a human, not the agent, releases this money.");
    return;
  }

  const settled = await engine.settle({
    order_id: accepted.order_id,
    token_id: accepted.token.token_id,
    session_id: sessionId,
    vpa: TEST_VPA_SUCCESS,
    simulate: async (orderId, vpa) => {
      const sim = await rail.simulateCheckout(orderId, vpa);
      return {
        paymentId: sim.payment.id,
        signature: sim.signature,
        failed: sim.payment.status === "failed",
      };
    },
  });

  if (settled.kind === "CAPTURED") {
    console.log(`\n  captured  ${formatINR(settled.amount)}  payment ${settled.payment_id}`);
    console.log(`  envelope  ${formatINR(settled.consumed_paise)} consumed`);
  } else {
    console.log(`\n  settle    ${settled.kind}`);
  }

  // Replaying the same authorisation must be impossible (F7).
  const replay = await engine.settle({
    order_id: accepted.order_id,
    token_id: accepted.token.token_id,
    session_id: sessionId,
    simulate: async () => ({ paymentId: "pay_replay", signature: "x", failed: false }),
  });
  console.log(`  replay    ${replay.kind === "REJECTED" ? replay.reason : replay.kind}`);
}

for (const scenario of SCENARIOS) {
  await run(scenario);
}

console.log(`\n${rule("=")}\nSakshi\n${rule("=")}`);
const verdict = sakshi.verify();
console.log(`  entries   ${sakshi.count()}`);
console.log(`  tip       ${sakshi.tipHash()}`);
console.log(
  `  chain     ${
    verdict.ok ? "INTACT" : `BROKEN at seq ${String(verdict.broken_at)} (${verdict.reason})`
  }`,
);
console.log(`\n  npm run verify   to check the chain independently\n`);

sakshi.close();
store.close();
