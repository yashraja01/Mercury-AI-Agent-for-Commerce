import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay signature verification.
 *
 * Two different signatures, two different secrets, two different messages --
 * conflating them is the classic integration bug, so they are separate
 * functions with explicit names.
 *
 *   checkout: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
 *   webhook:  HMAC_SHA256(raw_request_body,            webhook_secret)
 *
 * The webhook message is the RAW body. Parsing JSON and re-serialising it
 * before verifying will silently change the bytes and fail every time -- which
 * is why the webhook handler takes a string, never an object.
 */

/** Constant-time comparison of two hex digests. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function computeCheckoutSignature(
  orderId: string,
  paymentId: string,
  keySecret: string,
): string {
  return createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`, "utf8").digest("hex");
}

export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  return hexEqual(computeCheckoutSignature(orderId, paymentId, keySecret), signature);
}

export function computeWebhookSignature(rawBody: string, webhookSecret: string): string {
  return createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  webhookSecret: string,
): boolean {
  return hexEqual(computeWebhookSignature(rawBody, webhookSecret), signature);
}
