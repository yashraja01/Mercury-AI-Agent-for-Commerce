import { mercury, railMode } from "@/lib/mercury";
import { envelopeView } from "@/lib/run";
import { SCENARIOS } from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the header and the side panels need to render a cold page. */
export async function GET(): Promise<Response> {
  const m = mercury();
  const mandateIds = [...new Set(SCENARIOS.map((s) => s.mandate_id))];

  return Response.json({
    rail_mode: railMode(),
    frozen: m.store.isFrozen(),
    merchants: m.store.listMerchants(),
    envelopes: mandateIds.map((id) => envelopeView(id)).filter((e) => e !== undefined),
    ledger_count: m.sakshi.count(),
    tip: m.sakshi.tipHash(),
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      label: s.label,
      premise: s.premise,
      merchant_id: s.merchant_id,
      buyer: s.buyer,
      failure: s.failure ?? null,
    })),
  });
}
