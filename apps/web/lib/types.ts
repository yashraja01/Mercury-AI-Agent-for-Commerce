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
