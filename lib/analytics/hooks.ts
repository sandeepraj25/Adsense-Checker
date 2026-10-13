import { one } from "@/lib/db";
import { findPaymentByOrderId } from "@/lib/db/billing";
import { trackServerEvent } from "./store";

/**
 * Payment events, written from the server's own payment rows after the
 * existing verification flow has decided the outcome. Keyed by order, so
 * the browser return and the gateway webhook for the same payment record
 * it once. trackServerEvent never throws.
 */

function mode(value: string | null | undefined): string {
  return value === "live" ? "live" : "mock";
}

export function recordPaymentSucceeded(orderId: string): void {
  try {
    const payment = findPaymentByOrderId(orderId);
    if (!payment || payment.status !== "paid") return;
    const props = { plan: payment.planId, currency: payment.currency, gateway: payment.gateway, mode: mode(payment.mode) };
    trackServerEvent("payment_succeeded", { key: `paid:${orderId}`, userId: payment.userId, props });
    if (payment.subscriptionId) {
      const prior = one<{ x: number }>(
        "SELECT 1 AS x FROM subscriptions WHERE user_id = ? AND order_id IS NOT NULL AND id <> ? AND created_at <= (SELECT created_at FROM subscriptions WHERE id = ?) LIMIT 1",
        [payment.userId, payment.subscriptionId, payment.subscriptionId],
      );
      trackServerEvent("subscription_upgraded", {
        key: `sub:${payment.subscriptionId}`,
        userId: payment.userId,
        props: { plan: payment.planId, kind: prior ? "repeat" : "first", mode: mode(payment.mode) },
      });
    }
  } catch (error) {
    console.error("[analytics] payment succeeded", error instanceof Error ? error.message : error);
  }
}

export function recordPaymentFailed(orderId: string, status: "failed" | "cancelled"): void {
  try {
    const payment = findPaymentByOrderId(orderId);
    if (!payment) return;
    trackServerEvent("payment_failed", {
      key: `failed:${orderId}`,
      userId: payment.userId,
      props: {
        plan: payment.planId,
        currency: payment.currency,
        gateway: payment.gateway,
        reason: status === "cancelled" ? "CANCELLED" : "FAILED",
        mode: mode(payment.mode),
      },
    });
  } catch (error) {
    console.error("[analytics] payment failed", error instanceof Error ? error.message : error);
  }
}
