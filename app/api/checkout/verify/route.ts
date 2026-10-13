import { optionalUser } from "@/lib/auth/guard";
import { jsonError, jsonOk, jsonServerError, readJson, str } from "@/lib/http";
import { verifyCheckout } from "@/lib/payments";

export const runtime = "nodejs";

/**
 * Confirms a payment.
 *
 * The browser's "it worked" is treated as a hint that something happened
 * and nothing more. Each adapter then proves it independently — Razorpay by
 * an HMAC the browser cannot forge plus an API read-back, Cashfree and
 * PayPal by asking the gateway directly — and only a verified capture
 * grants a plan. Every payload key is forwarded untouched because the
 * adapters need the fields their own gateway sent; none of them is trusted.
 */
export async function POST(request: Request) {
  const user = await optionalUser();
  if (!user) return jsonError("UNAUTHENTICATED", "Log in to finish checkout.");

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  // Each gateway names the order differently on the way back.
  const orderId =
    str(body.orderId) ||
    str(body.razorpay_order_id) ||
    str(body.order_id) ||
    str(body.token);
  if (!orderId) return jsonError("VALIDATION_ERROR", "Missing order id.");

  try {
    const result = await verifyCheckout({
      userId: user.id,
      orderId,
      payload: body,
    });

    if (!result.ok) {
      // 202 for a payment that is still settling: nothing failed, the
      // answer just is not final yet, and the webhook will finish it.
      return jsonError(result.code, result.message, {
        status: result.pending ? 202 : undefined,
      });
    }

    return jsonOk({
      alreadyActive: result.status === "already",
      subscriptionId: result.subscriptionId,
      invoiceId: result.invoiceId,
      planId: result.planId,
      simulated: result.simulated,
    });
  } catch (error) {
    return jsonServerError("checkout/verify", error);
  }
}
