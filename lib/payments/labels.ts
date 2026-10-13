import { isGatewayId, type GatewayId } from "@/lib/db/types";

/**
 * Gateway display names, safe to import from a Client Component.
 *
 * `gatewayLabel` in ./registry reads the same names from the adapters,
 * but the adapters import node:crypto (signature checks), so a browser
 * bundle must not import the registry or the `@/lib/payments` barrel.
 * Keep these in step with each adapter's `label`.
 */
const LABELS: Record<GatewayId, string> = {
  razorpay: "Razorpay",
  cashfree: "Cashfree",
  paypal: "PayPal",
};

export function gatewayDisplayName(id: unknown): string {
  return isGatewayId(id) ? LABELS[id] : "Unknown gateway";
}
