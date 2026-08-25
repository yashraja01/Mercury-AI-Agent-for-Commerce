import "server-only";
import {
  type HolderProof,
  type RuleEval,
  holderChallenge,
  newNonce,
  signValue,
} from "@mercury/core";
import type { EventType } from "@mercury/sakshi";
import type { BenchStatus, ChaosCheck, ChaosResult, ChaosRow, FailureId } from "./chaos-types";
import type { WebhookEnvelope, WebhookEventName } from "@mercury/rail";
import { readWallet } from "@mercury/seed";
import { WALLET_PATH, mercury } from "./mercury";
import { envelopeView, runScenario } from "./run";
import { scenarioById } from "./scenarios";
import { quote } from "./transact";

/**
 * The Chaos Console.
 *
 * The failure-audit table has always existed as a claim in a markdown file.
 * This is the same table as an executable: each row injects its own failure,
 * then *checks* the recovery — the ledger events the row promises, and the
 * state that must not have moved. A row is green only when both hold.
 *
 * Two properties this file exists to enforce:
 *
 *  1. Nothing is asserted from the outside. Every row drives the same public
 *     surface a buyer or Razorpay would drive; the webhook rows go out over
 *     HTTP to this app's own route, because a webhook that was only ever
 *     handed to a class in-process has never been rejected *as a request*.
 *  2. The Sakshi expectations are the ones written in DEVLOG's audit table,
 *     copied here verbatim. If the two ever disagree, this file is the one
 *     that can be run.
 */

export type { BenchStatus, ChaosCheck, ChaosResult, ChaosRow, FailureId };

export const CHAOS_ROWS: ChaosRow[] = [
  {
    id: "F1",
    failure: "Parameter drift",
    injection: "The agent quotes a total its own line items do not add up to",
    expected: "Hard DENY on drift. No Razorpay call is made",
    sakshi: ["DRIFT_BLOCKED"],
  },
  {
    id: "F2",
    failure: "Payment decline",
    injection: "failure@razorpay — the payment fails at the rail",
    expected: "Bounded retries, then a UPI approval link back to a human",
    sakshi: ["PAYMENT_FAILED", "RETRY_BOUNDED", "STEPUP_ISSUED"],
  },
  {
    id: "F3",
    failure: "Undeliverable after capture",
    injection: "The warehouse reports the stock gone after the money moved",
    expected: "Automatic refund; stock and envelope restored; principal is whole",
    sakshi: ["PAYMENT_CAPTURED", "AUTO_REFUND_ISSUED"],
  },
  {
    id: "F4",
    failure: "Forged webhook",
    injection: "A genuine body delivered with a tampered X-Razorpay-Signature",
    expected: "400, order state untouched, and the genuine delivery still processes",
    sakshi: ["WEBHOOK_REJECTED", "WEBHOOK_ACCEPTED"],
  },
  {
    id: "F5",
    failure: "Out-of-order / duplicate webhook",
    injection: "captured arrives before authorized, then the captured event is replayed",
    expected: "Monotonic payment FSM converges; the replay is a no-op",
    sakshi: ["WEBHOOK_ACCEPTED", "WEBHOOK_DEDUPED"],
  },
  {
    id: "F6",
    failure: "Mandate breach",
    injection: "A basket beyond the mandate's per-transaction cap",
    expected: "DENY with exact observed and limit paise. Zero Razorpay calls",
    sakshi: ["MANDATE_BREACH_BLOCKED"],
  },
  {
    id: "F7",
    failure: "Token replay",
    injection: "The same intent token is redeemed twice over the buyer API",
    expected: "DENY TOKEN.REPLAY on the second. No duplicate order, no second capture",
    sakshi: ["PAYMENT_CAPTURED", "REPLAY_BLOCKED"],
  },
];

export function chaosRow(id: string): ChaosRow | undefined {
  return CHAOS_ROWS.find((r) => r.id === id);
}

/* -------------------------------------------------------------- the bench */

const BENCH_MANDATE = "mnd_household_weekly";
const BENCH_MERCHANT = "mch_quick";

/**
 * What the rows spend, measured against a freshly seeded database rather than
 * estimated: one full pass over the table costs one debit of the mandate's
 * eight, Rs 570 of its envelope, four bags of rice and one tin of ghee (the
 * ghee comes back, because F3 refunds it).
 *
 * F1 and F6 are denials and cost nothing. F2, F4 and F5 create orders without
 * capturing, so they take stock and no budget. F3 and F7 capture; F3 then
 * refunds, which restores both the envelope and the debit.
 */
const RUN_COST = { debits: 1, paise: 57_000, stock: { QC_RICE_5KG: 4 } };

/**
 * Stock a row needs on hand but does not use up.
 *
 * F3 buys the ghee and then refunds it, which puts the tin back on the shelf.
 * Counting it as a per-run cost would have said "1 full pass left" on a
 * freshly seeded bench, because the seed stocks exactly one tin -- a number
 * that is a level, not a drain.
 */
const RUN_REQUIRES = { QC_GHEE_1L: 1 };

/** The cheapest thing an order-taking row buys: one bag of rice. */
const ROW_COST_PAISE = 60_000;

/** Rows that must buy a live order before they can inject anything. */
const NEEDS_ORDER: ReadonlySet<FailureId> = new Set<FailureId>(["F2", "F3", "F4", "F5", "F7"]);

export function benchStatus(): BenchStatus {
  const m = mercury();
  const e = envelopeView(BENCH_MANDATE);
  const stock = [...Object.keys(RUN_COST.stock), ...Object.keys(RUN_REQUIRES)].map((sku) => ({
    sku,
    available: m.store.getItem(sku)?.stock ?? 0,
  }));

  if (e === undefined) {
    return {
      mandate_id: BENCH_MANDATE,
      txn_count: 0,
      max_txn_count: 0,
      remaining_paise: 0,
      reserved_paise: 0,
      stock,
      runs_left: 0,
      ready: false,
      reason: `no mandate ${BENCH_MANDATE} — the database has not been seeded`,
    };
  }

  const debitsLeft = Math.max(0, e.max_txn_count - e.txn_count);
  const consumable = Object.entries(RUN_COST.stock).map(([sku, per]) =>
    Math.floor((m.store.getItem(sku)?.stock ?? 0) / per),
  );
  const shortRequired = Object.entries(RUN_REQUIRES).find(
    ([sku, need]) => (m.store.getItem(sku)?.stock ?? 0) < need,
  );

  const runsLeft = shortRequired !== undefined
    ? 0
    : Math.max(
        0,
        Math.min(
          Math.floor(debitsLeft / RUN_COST.debits),
          Math.floor(e.remaining_paise / RUN_COST.paise),
          ...consumable,
        ),
      );

  const shortStock =
    shortRequired !== undefined
      ? { sku: shortRequired[0], available: m.store.getItem(shortRequired[0])?.stock ?? 0 }
      : stock.find((s) => s.available < 1);
  const reason =
    debitsLeft < 1
      ? `the mandate has spent all ${e.max_txn_count} of its debits`
      : e.remaining_paise < ROW_COST_PAISE
        ? `only Rs ${(e.remaining_paise / 100).toFixed(2)} of envelope left`
        : shortStock !== undefined
          ? `${shortStock.sku} is out of stock`
          : null;

  return {
    mandate_id: BENCH_MANDATE,
    txn_count: e.txn_count,
    max_txn_count: e.max_txn_count,
    remaining_paise: e.remaining_paise,
    reserved_paise: e.reserved_paise,
    stock,
    runs_left: runsLeft,
    ready: reason === null,
    reason,
  };
}

/* --------------------------------------------------------------- plumbing */

interface LedgerRow {
  event_type: string;
  detail?: Record<string, unknown>;
  decision?: { outcome: string; rule_ids: string[]; evidence: RuleEval[] };
}

class Window {
  readonly from: number;
  constructor(from: number) {
    this.from = from;
  }
  /** Everything Sakshi recorded since this window opened. */
  entries(): LedgerRow[] {
    return mercury().sakshi.read({ from: this.from }) as unknown as LedgerRow[];
  }
  types(): string[] {
    return [...new Set(this.entries().map((e) => e.event_type))];
  }
}

function openWindow(): Window {
  return new Window(mercury().sakshi.count() + 1);
}

/** The row's promised ledger events, each one its own check. */
function ledgerChecks(row: ChaosRow, w: Window): ChaosCheck[] {
  const types = w.types();
  return row.sakshi.map((t) => ({
    label: `Sakshi records ${t}`,
    passed: types.includes(t),
    detail: types.includes(t) ? "present in the chain" : `absent — saw ${types.join(", ") || "nothing"}`,
  }));
}

function absent(w: Window, type: EventType, why: string): ChaosCheck {
  const seen = w.types().includes(type);
  return { label: why, passed: !seen, detail: seen ? `${type} was written` : `no ${type}` };
}

/** Run a Mission Control scenario with the theatre's narration discarded. */
async function driveScenario(id: string): Promise<void> {
  const scenario = scenarioById(id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  await runScenario(scenario, "scripted", () => {});
}

function proveHolder(mandateId: string): HolderProof {
  const entry = readWallet(WALLET_PATH).find((a) => a.mandate_id === mandateId);
  if (entry === undefined) {
    throw new Error(`no key for ${mandateId} in ${WALLET_PATH} — run npm run seed`);
  }
  const body = { mandate_id: mandateId, nonce: newNonce(), issued_at: new Date().toISOString() };
  return { ...body, signature: signValue(holderChallenge(body), entry.agent_private_key) };
}

/* ------------------------------------------------------------- webhook kit */

interface Delivery {
  status: number;
  body: { status?: string; reason?: string; event_id?: string };
}

/**
 * A Razorpay-shaped delivery, signed the way Razorpay signs.
 *
 * `forge` is the whole point of F4: identical bytes, a signature that does not
 * match them. The route must be unable to tell the difference by any means
 * other than the HMAC.
 */
async function deliver(
  origin: string,
  event: WebhookEventName,
  payload: WebhookEnvelope["payload"],
  opts: { eventId: string; forge?: boolean },
): Promise<Delivery> {
  const m = mercury();
  const fixture = m.fixture;
  if (fixture === undefined) throw new Error("chaos webhooks need the fixture rail");

  const envelope: WebhookEnvelope = {
    entity: "event",
    account_id: "acc_FIXTURE",
    event,
    contains: Object.keys(payload),
    payload,
    created_at: Math.floor(Date.now() / 1000),
  };
  const raw = JSON.stringify(envelope);
  const signature = opts.forge === true ? fixture.signWebhook(`${raw} `) : fixture.signWebhook(raw);

  const res = await fetch(`${origin}/api/webhook/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": opts.eventId,
    },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as Delivery["body"] };
}

function paymentEntity(paymentId: string, orderId: string, status: "authorized" | "captured", amount: number) {
  return {
    payment: {
      entity: {
        id: paymentId,
        entity: "payment" as const,
        amount,
        currency: "INR" as const,
        status,
        order_id: orderId,
        method: "upi" as const,
        captured: status === "captured",
        created_at: Math.floor(Date.now() / 1000),
      },
    },
  };
}

/**
 * Why a setup quote was denied.
 *
 * Every row that needs a live order buys one first, and the demo mandate is
 * finite: eight transactions and Rs 5,000. Run the whole table five times and
 * the gate starts denying the *setup*, which would otherwise show up as a red
 * row that looks like a bug in the thing being tested. It is the bench running
 * out, and it should say so.
 */
function benchExhausted(reason: string): Error {
  const e = envelopeView("mnd_household_weekly");
  const state =
    e === undefined
      ? "no envelope"
      : `txn ${e.txn_count}/${e.max_txn_count}, Rs ${(e.remaining_paise / 100).toFixed(2)} left`;
  return new Error(`chaos setup was denied (${reason}) — demo mandate: ${state}. Press Reset.`);
}

/** An allowed, unpaid order to aim webhooks at. */
async function orderForWebhooks(): Promise<{ order_id: string; amount: number }> {
  const result = await quote({
    merchant_id: "mch_quick",
    mandate_id: "mnd_household_weekly",
    message: "One bag of rice, please.",
    internal: true,
  });
  if (result.cart === undefined) throw benchExhausted(result.outcome);
  return { order_id: result.cart.order_id, amount: result.cart.total_paise };
}

function paymentStatusOf(orderId: string): string {
  return mercury().store.getOrder(orderId)?.payment_status ?? "missing";
}

/* ------------------------------------------------------------------- rows */

async function runRow(row: ChaosRow, origin: string, w: Window): Promise<ChaosCheck[]> {
  switch (row.id) {
    case "F1": {
      await driveScenario("drift");
      return [
        ...ledgerChecks(row, w),
        absent(w, "ORDER_CREATED", "No order was created — the rail was never touched"),
        absent(w, "PAYMENT_CAPTURED", "No money moved"),
      ];
    }

    case "F2": {
      await driveScenario("decline");
      const retries = w
        .entries()
        .filter((e) => e.event_type === "RETRY_BOUNDED").length;
      return [
        ...ledgerChecks(row, w),
        {
          label: "Retries are bounded, not endless",
          passed: retries > 0 && retries <= 2,
          detail: `${retries} bounded retry event(s)`,
        },
        absent(w, "PAYMENT_CAPTURED", "Nothing was captured on the failing rail"),
      ];
    }

    case "F3": {
      const before = envelopeView("mnd_household_weekly")?.remaining_paise ?? -1;
      await driveScenario("oversold");
      const after = envelopeView("mnd_household_weekly")?.remaining_paise ?? -2;
      return [
        ...ledgerChecks(row, w),
        {
          label: "The envelope is restored to the paisa",
          passed: before === after,
          detail: `remaining ${before} -> ${after}`,
        },
      ];
    }

    case "F4": {
      const order = await orderForWebhooks();
      const stamp = Date.now();
      const payload = paymentEntity(`pay_chaos_${stamp}`, order.order_id, "captured", order.amount);
      const eventId = `evt_chaos_f4_${stamp}`;

      const forged = await deliver(origin, "payment.captured", payload, { eventId, forge: true });
      const afterForged = paymentStatusOf(order.order_id);
      // The same event id, now correctly signed: a forged delivery must not
      // have consumed it, or a forger could suppress the genuine event.
      const genuine = await deliver(origin, "payment.captured", payload, { eventId });
      const afterGenuine = paymentStatusOf(order.order_id);

      return [
        {
          label: "The forged delivery is rejected with 400",
          passed: forged.status === 400 && forged.body.status === "rejected",
          detail: `HTTP ${forged.status} ${forged.body.reason ?? ""}`.trim(),
        },
        {
          label: "Order state is untouched by the forgery",
          passed: afterForged === "created",
          detail: `payment_status ${afterForged}`,
        },
        {
          label: "The genuine delivery then processes",
          passed: genuine.status === 200 && genuine.body.status === "accepted",
          detail: `HTTP ${genuine.status} ${genuine.body.status ?? ""} -> payment_status ${afterGenuine}`,
        },
        ...ledgerChecks(row, w),
      ];
    }

    case "F5": {
      const order = await orderForWebhooks();
      const stamp = Date.now();
      const paymentId = `pay_chaos_${stamp}`;
      const capturedId = `evt_chaos_f5_cap_${stamp}`;

      // Out of order on purpose: the later event arrives first.
      const captured = await deliver(
        origin,
        "payment.captured",
        paymentEntity(paymentId, order.order_id, "captured", order.amount),
        { eventId: capturedId },
      );
      const afterCaptured = paymentStatusOf(order.order_id);

      const late = await deliver(
        origin,
        "payment.authorized",
        paymentEntity(paymentId, order.order_id, "authorized", order.amount),
        { eventId: `evt_chaos_f5_auth_${stamp}` },
      );
      const afterLate = paymentStatusOf(order.order_id);

      const replay = await deliver(
        origin,
        "payment.captured",
        paymentEntity(paymentId, order.order_id, "captured", order.amount),
        { eventId: capturedId },
      );
      const afterReplay = paymentStatusOf(order.order_id);

      return [
        {
          label: "The out-of-order captured event is accepted and applied",
          passed: captured.status === 200 && afterCaptured === "captured",
          detail: `HTTP ${captured.status} -> payment_status ${afterCaptured}`,
        },
        {
          label: "The late authorized does not wind the payment back",
          passed: late.status === 200 && afterLate === "captured",
          detail: `HTTP ${late.status} -> payment_status still ${afterLate}`,
        },
        {
          label: "The replayed event id is a no-op",
          passed:
            replay.status === 200 &&
            replay.body.status === "duplicate" &&
            afterReplay === "captured",
          detail: `HTTP ${replay.status} ${replay.body.status ?? ""} -> payment_status ${afterReplay}`,
        },
        ...ledgerChecks(row, w),
      ];
    }

    case "F6": {
      await driveScenario("breach");
      const breach = w.entries().find((e) => e.event_type === "MANDATE_BREACH_BLOCKED");
      const evidence = breach?.decision?.evidence?.[0];
      return [
        ...ledgerChecks(row, w),
        {
          label: "The denial carries exact observed and limit figures",
          passed: evidence !== undefined,
          detail:
            evidence === undefined
              ? "no rule evidence on the entry"
              : `${evidence.rule_id}: observed ${evidence.observed} vs limit ${evidence.limit} paise`,
        },
        absent(w, "ORDER_CREATED", "Zero Razorpay calls — no order was created"),
      ];
    }

    case "F7": {
      const mandateId = "mnd_household_weekly";
      const quoted = await quote({
        merchant_id: "mch_quick",
        mandate_id: mandateId,
        message: "One bag of rice, please.",
        holder_proof: proveHolder(mandateId),
      });
      if (quoted.cart === undefined) throw benchExhausted(quoted.outcome);

      const redeem = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
        const res = await fetch(`${origin}/api/agent/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order_id: quoted.cart?.order_id,
            intent_token_id: quoted.cart?.intent_token_id,
            session_id: quoted.session_id,
            holder_proof: proveHolder(mandateId),
          }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };

      const first = await redeem();
      const second = await redeem();
      const captures = w.entries().filter((e) => e.event_type === "PAYMENT_CAPTURED").length;

      return [
        {
          label: "The first redemption captures",
          passed: first.body["status"] === "captured",
          detail: `HTTP ${first.status} ${String(first.body["status"] ?? first.body["error"] ?? "")}`,
        },
        {
          label: "The replay is refused",
          passed: second.body["status"] === "rejected",
          detail: `HTTP ${second.status} ${String(second.body["reason"] ?? second.body["error"] ?? "")}`,
        },
        {
          label: "Exactly one capture, no duplicate order",
          passed: captures === 1,
          detail: `${captures} PAYMENT_CAPTURED entries`,
        },
        ...ledgerChecks(row, w),
      ];
    }
  }
}

/**
 * Run one row of the failure-audit table and report what actually happened.
 *
 * `origin` is this app's own base URL, supplied by the route. The webhook and
 * replay rows use it to make real requests to real routes: an in-process call
 * would prove the engine works and say nothing about the wire.
 */
export async function runChaos(id: FailureId, origin: string): Promise<ChaosResult> {
  const row = chaosRow(id);
  if (row === undefined) throw new Error(`unknown failure row: ${id}`);

  const started = Date.now();

  /*
   * Preflight. A row that needs a live order is checked against the bench
   * *before* it injects anything, because a setup denied for lack of budget
   * produces exactly the symptoms of the failure the row exists to test. It is
   * reported as blocked, not failed, and nothing is written to the ledger.
   */
  const bench = benchStatus();
  if (NEEDS_ORDER.has(row.id) && !bench.ready) {
    return {
      ...row,
      blocked: true,
      passed: false,
      checks: [
        {
          label: "The bench has budget to run this row",
          passed: false,
          detail: `${bench.reason ?? "bench spent"} — press Reset (or npm run chaos -- --reset) to re-seed`,
        },
      ],
      observed: [],
      ledger_from: mercury().sakshi.count(),
      ledger_to: mercury().sakshi.count(),
      duration_ms: Date.now() - started,
      bench,
    };
  }

  const w = openWindow();
  let checks: ChaosCheck[];

  try {
    checks = await runRow(row, origin, w);
  } catch (e) {
    checks = [
      { label: "The injection ran", passed: false, detail: (e as Error).message },
      ...ledgerChecks(row, w),
    ];
  }

  return {
    ...row,
    blocked: false,
    checks,
    passed: checks.every((c) => c.passed),
    observed: w.types(),
    ledger_from: w.from,
    ledger_to: mercury().sakshi.count(),
    duration_ms: Date.now() - started,
    bench: benchStatus(),
  };
}
