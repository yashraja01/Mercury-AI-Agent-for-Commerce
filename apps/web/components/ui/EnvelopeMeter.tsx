"use client";

import { rupees } from "@/lib/format";
import type { EnvelopeView } from "@/lib/types";

/**
 * How much authority a mandate has left.
 *
 * The bar reads left-to-right as spent; what remains is authority the agent
 * still holds. Brass for spent, because Dwaar is what released it.
 */
export function EnvelopeMeter({
  envelope,
  label,
}: {
  envelope: EnvelopeView;
  label: string;
}) {
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

/** The mandate id, as a label a human reads. `mnd_household_weekly` -> `household weekly`. */
export function envelopeLabel(mandateId: string): string {
  return mandateId.replace("mnd_", "").replace(/_/gu, " ");
}
