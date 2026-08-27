"use client";

import { bps, rupees } from "@/lib/format";
import type { MerchantSummary } from "@/lib/types";

/**
 * What the Revenue Agent earned.
 *
 * The signature reading is two figures and the gap between them: the basket the
 * buyer asked for at ordinary pricing, and the basket the gate approved. Goal 1
 * is the claim that an agent can grow the second without breaking the merchant's
 * own rules, and this is the only honest way to show it -- measured on outcomes,
 * read back out of the chain, and negative when the agent did worse than doing
 * nothing.
 */

const LEVER_LABEL: Record<string, string> = {
  bulk_tier: "Bulk tier",
  bundle: "Bundle",
  substitute: "Substitute",
  credit_terms: "Credit terms",
};

export function RevenuePanel({ summary }: { summary: MerchantSummary | null }) {
  const uplift = summary?.uplift_paise ?? 0;
  const empty = (summary?.baskets ?? 0) === 0;

  // Brass when the agent earned something, vermilion when it cost the merchant.
  const tone = empty ? "text-paper-faint" : uplift < 0 ? "text-vermilion" : "text-brass";

  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="panel-head flex items-baseline justify-between px-4 py-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em] text-paper">
          Revenue
        </h2>
        <span className="eyebrow">
          {empty ? "no baskets yet" : `${summary?.baskets} baskets negotiated`}
        </span>
      </div>

      <div className="border-b border-rule px-4 py-4">
        <div className="grid grid-cols-3 gap-px bg-rule">
          <div className="bg-ink-raised px-3 py-3">
            <span className="eyebrow">Buyer asked</span>
            <p className="figures mt-1.5 text-[19px] text-paper-dim">
              {empty ? "—" : rupees(summary?.baseline_paise ?? 0)}
            </p>
          </div>

          <div className="bg-ink-raised px-3 py-3">
            <span className="eyebrow">Gate approved</span>
            <p className="figures mt-1.5 text-[19px] text-paper">
              {empty ? "—" : rupees(summary?.final_paise ?? 0)}
            </p>
          </div>

          <div className="bg-ink-raised px-3 py-3">
            <span className="eyebrow">Uplift</span>
            <p className={`figures mt-1.5 text-[22px] ${tone}`}>
              {empty ? "—" : bps(summary?.uplift_bps ?? 0, { sign: true })}
            </p>
            <p className={`figures mt-0.5 text-[12px] ${tone}`}>
              {empty ? "" : `${uplift > 0 ? "+" : ""}${rupees(uplift)}`}
            </p>
          </div>
        </div>

        <p className="mt-3 max-w-[70ch] text-[12px] leading-relaxed text-paper-faint">
          Measured, not asserted. Every figure here is summed from BASKET_VALUED
          entries in the chain, so it is the same number an outside party would
          reach by walking the ledger.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <p className="mt-8 px-4 text-center text-[13px] text-paper-faint">
            Nothing negotiated yet. Run a scenario in Mission Control.
          </p>
        ) : (
          <ul>
            {(summary?.levers ?? []).map((l) => (
              <li
                key={l.lever}
                className="flex items-baseline gap-3 border-b border-rule px-4 py-2.5 last:border-0"
              >
                <span className="min-w-0 flex-1 text-[13px] text-paper">
                  {LEVER_LABEL[l.lever] ?? l.lever}
                </span>
                <span className="figures text-[11px] text-paper-faint">
                  {l.baskets} {l.baskets === 1 ? "basket" : "baskets"}
                </span>
                <span className="figures w-[110px] text-right text-[13px] text-brass">
                  {l.uplift_paise > 0 ? "+" : ""}
                  {rupees(l.uplift_paise)}
                </span>
              </li>
            ))}

            {(summary?.levers.length ?? 0) === 0 ? (
              <p className="px-4 py-4 text-[12px] text-paper-faint">
                Uplift came from volume the buyer chose, not from a lever the
                agent pulled.
              </p>
            ) : null}
          </ul>
        )}
      </div>

      {(summary?.levers.length ?? 0) > 1 ? (
        <p className="border-t border-rule px-4 py-2 text-[11px] text-paper-faint">
          A basket that used two levers splits its uplift evenly between them.
          The gate priced the cart, not each lever&apos;s share of it.
        </p>
      ) : null}
    </section>
  );
}
