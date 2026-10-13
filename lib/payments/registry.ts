import { GATEWAY_IDS, isGatewayId, type GatewayId } from "@/lib/db/types";

import { cashfree } from "./cashfree";
import { paypal } from "./paypal";
import { razorpay } from "./razorpay";
import type { Gateway } from "./types";

/**
 * The three adapters, in the order they should appear at checkout.
 *
 * Deliberately dumb: a map and two lookups, no side effects and no
 * database access, so anything may import it — including the credential
 * store in `config.ts`, which needs each gateway's field list and would
 * otherwise create an import cycle.
 */

export const GATEWAYS: Record<GatewayId, Gateway> = {
  razorpay,
  cashfree,
  paypal,
};

/** Every adapter, in `GATEWAY_IDS` order. */
export const GATEWAY_LIST: Gateway[] = GATEWAY_IDS.map((id) => GATEWAYS[id]);

/** Adapter for an untrusted id — a request body, a route parameter. */
export function gatewayFor(id: unknown): Gateway | null {
  return isGatewayId(id) ? GATEWAYS[id] : null;
}

/** The label alone, for copy and audit-log lines. */
export function gatewayLabel(id: unknown): string {
  return gatewayFor(id)?.label ?? "Unknown gateway";
}
