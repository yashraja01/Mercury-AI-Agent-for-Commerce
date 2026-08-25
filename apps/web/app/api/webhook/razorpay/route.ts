import { mercury, webhookSecretStatus } from "@/lib/mercury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Razorpay's webhook endpoint.
 *
 * The two rules that matter are both about *not* trusting the body:
 *
 *  1. Read it as raw text and verify the HMAC against those exact bytes.
 *     `req.json()` would parse before verifying, and re-serialising changes
 *     the bytes, so a genuine delivery would fail its own signature.
 *  2. Return 400 on a bad signature and touch nothing. A forged delivery is a
 *     handled, expected condition -- it lands in Sakshi as WEBHOOK_REJECTED and
 *     leaves order state exactly where it was (F4).
 *
 * A duplicate is a 200: Razorpay retries until it gets one, and answering an
 * already-processed event with an error would only produce more retries (F5).
 */
export async function POST(req: Request): Promise<Response> {
  /*
   * A missing secret is a misconfiguration, not a forgery. Without this check
   * every genuine Razorpay delivery would be answered with "signature does not
   * match" and recorded in Sakshi as a rejected webhook -- an audit trail
   * full of attacks that never happened. 503 also tells Razorpay to retry,
   * which is exactly right: the deliveries are fine, we are not ready for them.
   */
  const secret = webhookSecretStatus();
  if (!secret.configured) {
    return Response.json(
      {
        status: "not_configured",
        reason:
          "RAZORPAY_WEBHOOK_SECRET is not set, so no delivery can be verified. " +
          "Set it to the secret from the Razorpay dashboard (Settings -> Webhooks).",
      },
      { status: 503 },
    );
  }

  const raw = await req.text();
  const verdict = mercury().engine.handleWebhook(raw, {
    "x-razorpay-signature": req.headers.get("x-razorpay-signature") ?? undefined,
    "x-razorpay-event-id": req.headers.get("x-razorpay-event-id") ?? undefined,
  });

  switch (verdict.kind) {
    case "REJECTED_SIGNATURE":
      return Response.json({ status: "rejected", reason: verdict.reason }, { status: 400 });
    case "REJECTED_MALFORMED":
      return Response.json({ status: "malformed", reason: verdict.reason }, { status: 400 });
    case "DUPLICATE":
      return Response.json({ status: "duplicate", event_id: verdict.event_id });
    default:
      return Response.json({
        status: "accepted",
        event_id: verdict.event_id,
        event: verdict.event.event,
      });
  }
}
