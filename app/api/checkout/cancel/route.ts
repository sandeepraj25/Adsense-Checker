import { optionalUser } from "@/lib/auth/guard";
import { findPaymentByOrderId, markPaymentFailed } from "@/lib/db/billing";
import { jsonError, jsonOk, readJson, str } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Called when the checkout sheet is dismissed. Closing an abandoned
 * order keeps the billing history readable — an unexplained `created`
 * row looks like a bug, `cancelled` looks like a decision.
 *
 * Guarded on status='created', so this can never undo a real payment.
 */
export async function POST(request: Request) {
  const user = await optionalUser();
  if (!user) return jsonError("UNAUTHENTICATED", "Log in first.");

  const body = await readJson(request);
  const orderId = str(body?.orderId);
  if (!orderId) return jsonError("VALIDATION_ERROR", "Missing order id.");

  const payment = findPaymentByOrderId(orderId);
  if (!payment || payment.userId !== user.id) {
    return jsonError("ORDER_NOT_FOUND", "We cannot find that order.");
  }

  markPaymentFailed(orderId, "Cancelled at checkout", "cancelled");
  return jsonOk({});
}
