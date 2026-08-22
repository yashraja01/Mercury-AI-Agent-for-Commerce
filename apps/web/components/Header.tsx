"use client";

import { rupees } from "@/lib/format";
import type { EnvelopeView, StateView } from "@/lib/types";

/**
 * The board's top rail: what mode we are in, what authority is left, and the
 * one control that stops everything.
 */

function EnvelopeMeter({ envelope, label }: { envelope: EnvelopeView; label: string }) {
  const used =
    envelope.reserved_paise === 0
      ? 0
      : Math.min(100, (envelope.consumed_paise / envelope.reserved_paise) * 100);

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow truncate">{label}</span>
        <span className="figures text-[11px] text-paper-dim">
          {envelope.txn_count}/{envelope.max_txn_count} debits
        </span>
      </div>

      {/* The bar reads left-to-right as spent; what remains is authority the
          agent still holds. Brass for spent, because Dwaar released it. */}
      <div className="mt-1.5 h-[6px] w-full bg-ink-sunk ring-1 ring-rule">
        <div
          className="h-full bg-brass transition-[width] duration-500 ease-out"
          style={{ width: `${used}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <span className="figures text-[13px] text-paper">
          {rupees(envelope.remaining_paise)}
          <span className="ml-1.5 text-[11px] text-paper-faint">left</span>
        </span>
        <span className="figures text-[11px] text-paper-faint">
          of {rupees(envelope.reserved_paise)}
        </span>
      </div>
    </div>
  );
}

export function Header({
  state,
  busy,
  onFreeze,
  onReset,
}: {
  state: StateView | null;
  busy: boolean;
  onFreeze: (frozen: boolean) => void;
  onReset: () => void;
}) {
  const frozen = state?.frozen ?? false;

  return (
    <header className="border-b border-rule bg-ink-sunk">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-5 px-6 py-4 xl:flex-row xl:items-center xl:gap-10">
        <div className="flex items-center gap-5">
          <div>
            <h1 className="font-mono text-[22px] font-semibold tracking-[0.22em] text-paper">
              MERCURY
            </h1>
            <p className="mt-0.5 text-[12px] leading-snug text-paper-dim">
              Two agents negotiate. A gate decides whether a rupee may move.
            </p>
          </div>

          <span
            className={`figures shrink-0 border px-2 py-1 text-[10px] uppercase tracking-[0.14em] ${
              state?.rail_mode === "live"
                ? "border-vermilion-dim text-vermilion"
                : "border-rule-bright text-paper-dim"
            }`}
            title={
              state?.rail_mode === "live"
                ? "Live Razorpay test keys"
                : "Recorded Razorpay shapes. No network."
            }
          >
            rail: {state?.rail_mode ?? "..."}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-5 sm:flex-row">
          {(state?.envelopes ?? []).map((e) => (
            <EnvelopeMeter
              key={e.mandate_id}
              envelope={e}
              label={e.mandate_id.replace("mnd_", "").replace(/_/gu, " ")}
            />
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="border border-rule-bright px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-paper-dim transition-colors hover:border-paper-faint hover:text-paper disabled:opacity-40"
          >
            Reset
          </button>

          {/* The kill switch. CIRCUIT.FROZEN is the first rule Dwaar checks, so
              this takes effect on the very next evaluation. */}
          <button
            type="button"
            onClick={() => onFreeze(!frozen)}
            aria-pressed={frozen}
            className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
              frozen
                ? "pulse-freeze border-vermilion bg-vermilion/15 text-vermilion"
                : "border-vermilion-dim text-vermilion hover:bg-vermilion/10"
            }`}
          >
            {frozen ? "Frozen — unfreeze" : "Freeze all spend"}
          </button>
        </div>
      </div>

      {frozen ? (
        <div className="border-t border-vermilion-dim bg-vermilion/10 px-6 py-2 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-vermilion">
          Spend is frozen. Every proposal now fails on CIRCUIT.FROZEN, whatever it contains.
        </div>
      ) : null}
    </header>
  );
}
