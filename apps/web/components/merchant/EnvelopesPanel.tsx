"use client";

import { EnvelopeMeter, envelopeLabel } from "@/components/ui/EnvelopeMeter";
import type { EnvelopeView } from "@/lib/types";

/**
 * Standing authority: how much a buyer may still spend here, and on how many
 * more debits.
 *
 * This is the merchant's view of somebody else's budget, which sounds odd until
 * you remember the merchant is the one who has to refuse when it runs out. The
 * envelope is Reserve-Pay-shaped -- one block, many debits, residual released on
 * close -- so both the rupees and the debit count can run out first, and the
 * gate stops on whichever does.
 */

export function EnvelopesPanel({ envelopes }: { envelopes: EnvelopeView[] }) {
  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="panel-head flex items-baseline justify-between px-4 py-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em] text-paper">
          Authority
        </h2>
        <span className="eyebrow">reserve mandates</span>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {envelopes.length === 0 ? (
          <p className="mt-4 text-center text-[13px] text-paper-faint">
            No live mandates. Try Reset.
          </p>
        ) : (
          envelopes.map((e) => (
            <EnvelopeMeter key={e.mandate_id} envelope={e} label={envelopeLabel(e.mandate_id)} />
          ))
        )}
      </div>

      <p className="border-t border-rule px-4 py-2.5 text-[11px] leading-relaxed text-paper-faint">
        Both limits bind. A mandate with rupees left but no debits left is spent,
        and MANDATE.VELOCITY is what says so.
      </p>
    </section>
  );
}
