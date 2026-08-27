import type { CartLine, RuleEval } from "@mercury/core";

/**
 * The wire shape between the server's run loop and the browser.
 *
 * Kept out of `run.ts` because that module is `server-only` -- the client needs
 * these types to render, but must never be able to pull the engine in with them.
 */

export interface OfferLine {
  sku: string;
  title: string;
  qty: number;
  unit_paise: number;
  list_paise: number;
}

export interface EnvelopeView {
  mandate_id: string;
  reserved_paise: number;
  consumed_paise: number;
  remaining_paise: number;
  txn_count: number;
  max_txn_count: number;
}

export type Outcome = "ALLOW" | "ALLOW_WITH_STEPUP" | "DENY";

export type TheatreEvent =
  | { type: "buyer"; text: string }
  | { type: "offer"; round: number; lines: OfferLine[]; quoted_paise: number; rationale: string }
  | {
      type: "verdict";
      round: number;
      outcome: Outcome;
      rules: RuleEval[];
      computed_paise: number | undefined;
      quoted_paise: number;
      messages: string[];
    }
  | { type: "order"; order_id: string; amount_paise: number; cart: CartLine[] }
  | { type: "stepup"; link_url: string; reason: string }
  | { type: "payment"; status: "captured" | "failed" | "fallback"; detail: string; attempt: number }
  | {
      /** Razorpay Route: one payment, several sellers paid out of it. */
      type: "split";
      captured_paise: number;
      commission_paise: number;
      legs: { account: string; amount_paise: number }[];
    }
  | { type: "merchant"; text: string }
  | { type: "note"; text: string }
  | { type: "done"; envelope: EnvelopeView; ledger_seq: number };

export interface ScenarioView {
  id: string;
  label: string;
  premise: string;
  merchant_id: string;
  buyer: string;
  failure: string | null;
}

export interface StateView {
  rail_mode: "fixture" | "live";
  frozen: boolean;
  merchants: { merchant_id: string; display_name: string; vertical: string }[];
  envelopes: EnvelopeView[];
  ledger_count: number;
  tip: string;
  scenarios: ScenarioView[];
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  event_type: string;
  actor: { type: string; id: string };
  hash: string;
  prev_hash: string;
  decision?: { outcome: string; rule_ids: string[] };
  razorpay?: Record<string, unknown>;
  envelope?: { reserved_paise: number; consumed_paise: number; remaining_paise: number };
  detail?: Record<string, unknown>;
}

/* ------------------------------------------------------ the merchant console */

/**
 * A merchant's policy, plus which of it no longer matches the seed.
 *
 * `modified` exists because the bench is durable: a margin floor raised for one
 * demo beat is still raised an hour later, and a chaos row failing for that
 * reason looks exactly like a regression. Naming the drift on screen is cheaper
 * than explaining it afterwards.
 */
export interface PolicyView {
  profile: MerchantProfileView;
  modified: string[];
  seeded: MerchantProfileView | null;
}

export interface MerchantProfileView {
  merchant_id: string;
  display_name: string;
  vertical: string;
  min_margin_bps: number;
  max_discount_bps: number;
  levers: string[];
  category_taxonomy: string[];
  settlement?: { mode: string; commission_bps: number; commission_account_id: string };
}

export interface LeverEarning {
  lever: string;
  baskets: number;
  uplift_paise: number;
}

export interface OrderView {
  order_id: string;
  mandate_id: string;
  amount_paise: number;
  status: string;
  payment_status: string;
  created_at: string | null;
}

export interface MerchantSummary {
  merchant_id: string;
  baskets: number;
  baseline_paise: number;
  final_paise: number;
  uplift_paise: number;
  uplift_bps: number;
  levers: LeverEarning[];
  orders: OrderView[];
}
