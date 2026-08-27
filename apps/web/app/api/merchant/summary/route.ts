import { mercury } from "@/lib/mercury";
import type { LeverEarning, MerchantSummary, OrderView } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the Revenue Agent earned this merchant, read back out of the chain.
 *
 * Deliberately computed from Sakshi rather than from a running total kept
 * somewhere convenient. The uplift a merchant sees is therefore the same number
 * an outside party would arrive at by walking the ledger -- if the two could
 * disagree, the audit trail would not be the source of truth, it would be a
 * copy of one.
 */

interface ValuedDetail {
  merchant_id?: unknown;
  baseline_paise?: unknown;
  final_paise?: unknown;
  uplift_paise?: unknown;
  levers_used?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export async function GET(req: Request): Promise<Response> {
  const merchantId = new URL(req.url).searchParams.get("merchant_id");
  if (merchantId === null) return Response.json({ error: "merchant_id required" }, { status: 400 });

  const m = mercury();

  const valued = m.sakshi
    .byEventType("BASKET_VALUED")
    .map((e) => (e.detail ?? {}) as ValuedDetail)
    .filter((d) => d.merchant_id === merchantId);

  let baseline = 0;
  let final = 0;
  const byLever = new Map<string, LeverEarning>();

  for (const d of valued) {
    baseline += num(d.baseline_paise);
    final += num(d.final_paise);

    const levers = Array.isArray(d.levers_used) ? (d.levers_used as unknown[]) : [];
    for (const raw of levers) {
      if (typeof raw !== "string") continue;
      const entry = byLever.get(raw) ?? { lever: raw, baskets: 0, uplift_paise: 0 };
      entry.baskets += 1;
      /*
       * Attribution is even across the levers a basket used, not clever. Two
       * levers on one basket cannot be separated after the fact -- the gate
       * priced the cart, not each lever's contribution to it -- and inventing a
       * weighting would dress a guess up as a measurement.
       */
      entry.uplift_paise += Math.round(num(d.uplift_paise) / levers.length);
      byLever.set(raw, entry);
    }
  }

  const uplift = final - baseline;

  const orders: OrderView[] = m.store
    .listOrders({ merchantId, limit: 25 })
    .map((o) => ({
      order_id: o.order_id,
      mandate_id: o.mandate_id,
      amount_paise: o.amount,
      status: o.status,
      payment_status: o.payment_status,
      created_at: o.created_at,
    }));

  const summary: MerchantSummary = {
    merchant_id: merchantId,
    baskets: valued.length,
    baseline_paise: baseline,
    final_paise: final,
    uplift_paise: uplift,
    uplift_bps: baseline === 0 ? 0 : Math.round((uplift / baseline) * 10_000),
    levers: [...byLever.values()].sort((a, b) => b.uplift_paise - a.uplift_paise),
    orders,
  };

  return Response.json(summary);
}
