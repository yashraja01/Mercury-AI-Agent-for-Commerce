"use client";

import { clockTime, shortHash } from "@/lib/format";
import type { LedgerEntry } from "@/lib/types";

/**
 * Sakshi, the witness.
 *
 * Each row shows its own hash and the hash it commits to. The chain is the
 * point: an entry cannot be edited without breaking every entry after it, and
 * "verify" re-walks the whole file to prove that here, in front of you, rather
 * than reporting a cached answer.
 */

export interface VerifyState {
  ok: boolean;
  count: number;
  tip: string;
  took_ms: number;
  broken_at?: number;
  reason?: string;
}

const EVENT_TONE: Record<string, string> = {
  MANDATE_ISSUED: "text-paper-dim",
  OFFER_PROPOSED: "text-paper-dim",
  DWAAR_DECISION: "text-brass",
  DRIFT_BLOCKED: "text-vermilion",
  MANDATE_BREACH_BLOCKED: "text-vermilion",
  REPLAY_BLOCKED: "text-vermilion",
  INVENTORY_CONFLICT: "text-vermilion",
  WEBHOOK_REJECTED: "text-vermilion",
  CIRCUIT_FROZEN: "text-vermilion",
  PAYMENT_FAILED: "text-vermilion",
  REPRICED: "text-brass",
  ORDER_CREATED: "text-brass",
  STEPUP_ISSUED: "text-brass",
  PAYMENT_CAPTURED: "text-verdigris",
  AUTO_REFUND_ISSUED: "text-verdigris",
  ENVELOPE_RESIDUAL_RELEASED: "text-verdigris",
};

export function SakshiPanel({
  entries,
  count,
  tip,
  verify,
  verifying,
  onVerify,
}: {
  entries: LedgerEntry[];
  count: number;
  tip: string;
  verify: VerifyState | null;
  verifying: boolean;
  onVerify: () => void;
}) {
  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="panel-head flex items-baseline justify-between px-4 py-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em] text-paper">
          Sakshi
          <span className="deva ml-2 text-[15px] font-normal text-paper-dim">साक्षी</span>
        </h2>
        <span className="eyebrow">{count} entries · newest first</span>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <span className="eyebrow">Tip</span>
          <p className="hash mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">
            {tip === "" ? "—" : tip}
          </p>
        </div>
        <button
          type="button"
          onClick={onVerify}
          disabled={verifying}
          className="shrink-0 border border-rule-bright px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-paper-dim transition-colors hover:border-paper-faint hover:text-paper disabled:opacity-40"
        >
          {verifying ? "Walking…" : "Verify chain"}
        </button>
      </div>

      {verify === null ? null : (
        <div
          className={`border-b px-4 py-2 font-mono text-[11px] ${
            verify.ok
              ? "border-verdigris-dim bg-verdigris/10 text-verdigris"
              : "border-vermilion-dim bg-vermilion/10 text-vermilion"
          }`}
        >
          {verify.ok
            ? `Chain intact — ${verify.count} entries re-hashed in ${verify.took_ms}ms`
            : `Chain broken at seq ${String(verify.broken_at)} (${String(verify.reason)})`}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-4 py-4 text-[12px] text-paper-faint">The ledger is empty.</p>
        ) : (
          <ol>
            {/* Newest first: a live panel should not need scrolling to
                show what just happened. */}
            {[...entries].reverse().map((e) => (
              <li key={e.seq} className="border-b border-rule/50 px-4 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="figures w-8 shrink-0 text-[11px] text-paper-faint">
                    {e.seq}
                  </span>
                  <span
                    className={`figures flex-1 truncate text-[12px] ${
                      EVENT_TONE[e.event_type] ?? "text-paper-dim"
                    }`}
                  >
                    {e.event_type}
                  </span>
                  <span className="figures shrink-0 text-[10px] text-paper-faint">
                    {clockTime(e.ts)}
                  </span>
                </div>

                <div className="mt-0.5 flex items-baseline gap-2 pl-10">
                  {/* prev <- self. The arrow is the chain, drawn once per row. */}
                  <span className="hash">{shortHash(e.prev_hash, 8)}</span>
                  <span className="text-[10px] text-rule-bright">&larr;</span>
                  <span className="hash text-paper-dim">{shortHash(e.hash, 8)}</span>
                  {e.decision === undefined ? null : (
                    <span className="figures ml-auto truncate text-[10px] text-paper-faint">
                      {e.decision.outcome}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
