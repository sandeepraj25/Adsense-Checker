"use client";

import type { ApiErrorCode } from "@/lib/http";
import type { PlanId } from "@/lib/plans";

/**
 * Hands an opened order to the gateway's own secure interface.
 *
 * Moved here from the pricing page's CheckoutButton so the checkout page
 * reuses it unchanged. Nothing in this file decides that a payment
 * succeeded: Razorpay's callback, Cashfree's redirect and PayPal's
 * approval all end at a server verification, and the plan is granted only
 * by that. Card numbers, UPI PINs and bank logins are typed into the
 * gateway's sheet or page, never into this application.
 */

const RAZORPAY_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";
const CASHFREE_SCRIPT = "https://sdk.cashfree.com/js/v3/cashfree.js";

type RazorpaySuccess = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayInstance = { open: () => void; on?: (event: string, cb: (r: unknown) => void) => void };
type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

type CashfreeInstance = {
  checkout: (options: { paymentSessionId: string; redirectTarget?: string }) => Promise<unknown> | void;
};
type CashfreeFactory = (options: { mode: string }) => CashfreeInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
    Cashfree?: CashfreeFactory;
  }
}

/** Mirrors `OrderResult["handoff"]`, which is deliberately secret-free. */
export type Handoff =
  | { kind: "razorpay_checkout"; keyId: string; orderId: string }
  | { kind: "cashfree_session"; sessionId: string; mode: "live" | "sandbox" }
  | { kind: "redirect"; url: string }
  | { kind: "mock"; orderId: string };

export type OrderResponse = {
  ok: true;
  gateway: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  planId: PlanId;
  planName: string;
  simulated: boolean;
  replayed: boolean;
  handoff: Handoff;
  prefill: { name: string; email: string; contact?: string };
};

export type ApiFailure = {
  ok: false;
  code: ApiErrorCode;
  message: string;
  fields?: Record<string, string>;
};

/** Loads a gateway's script once, and resolves on the copy already there. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("script")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "1";
      resolve();
    };
    script.onerror = () => reject(new Error("script"));
    document.head.appendChild(script);
  });
}

export type VerifyOutcome =
  | { kind: "confirmed"; orderId: string }
  | { kind: "pending"; orderId: string; message: string }
  | { kind: "failed"; message: string };

/** Asks the server to verify with the gateway. Never trusts the callback. */
export async function verifyOrder(payload: Record<string, string>): Promise<VerifyOutcome> {
  const orderId = payload.orderId ?? payload.razorpay_order_id ?? "";
  try {
    const res = await fetch("/api/checkout/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok: true } | ApiFailure;
    if (data.ok) return { kind: "confirmed", orderId };
    // 202: the gateway has not finished — not a refusal.
    if (res.status === 202) return { kind: "pending", orderId, message: data.message };
    return { kind: "failed", message: data.message };
  } catch {
    return {
      kind: "failed",
      message:
        "We could not confirm the payment. If money left your account, your billing page will update once the provider confirms it.",
    };
  }
}

export function cancelOrder(orderId: string): void {
  void fetch("/api/checkout/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  }).catch(() => {});
}

export type HandoffEvents = {
  /** Server verification finished (any outcome). */
  onVerified: (outcome: VerifyOutcome) => void;
  /** The customer closed the gateway's sheet. The order was cancelled. */
  onDismissed: () => void;
  /** The gateway's script or SDK could not start. Nothing was charged. */
  onUnavailable: (message: string) => void;
};

export async function openGateway(order: OrderResponse, events: HandoffEvents): Promise<void> {
  switch (order.handoff.kind) {
    /* The local simulator, development only. The row is stamped mock, so
       it can never be mistaken for — or settled as — a real collection. */
    case "mock": {
      events.onVerified(await verifyOrder({ orderId: order.handoff.orderId }));
      return;
    }

    case "razorpay_checkout": {
      const handoff = order.handoff;
      try {
        await loadScript(RAZORPAY_SCRIPT);
      } catch {
        events.onUnavailable(
          "Razorpay did not load. A network problem or a content blocker may be blocking checkout.razorpay.com. Nothing was charged.",
        );
        return;
      }
      const Razorpay = window.Razorpay;
      if (!Razorpay) {
        events.onUnavailable("Razorpay did not load. Reload the page and try again. Nothing was charged.");
        return;
      }
      new Razorpay({
        key: handoff.keyId,
        amount: order.amountPaise,
        currency: order.currency,
        order_id: handoff.orderId,
        name: "AdSense Checker",
        description: `${order.planName} — monthly`,
        prefill: order.prefill,
        theme: { color: "#4f46e5" },
        handler: (response: RazorpaySuccess) => {
          void verifyOrder({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          }).then(events.onVerified);
        },
        modal: {
          ondismiss: () => {
            cancelOrder(order.orderId);
            events.onDismissed();
          },
        },
      }).open();
      return;
    }

    /* Cashfree takes over the tab and returns to /dashboard/billing/return,
       which is where the verification happens. */
    case "cashfree_session": {
      const handoff = order.handoff;
      try {
        await loadScript(CASHFREE_SCRIPT);
      } catch {
        events.onUnavailable(
          "Cashfree did not load. A network problem or a content blocker may be blocking sdk.cashfree.com. Nothing was charged.",
        );
        return;
      }
      const factory = window.Cashfree;
      if (!factory) {
        events.onUnavailable("Cashfree did not load. Reload the page and try again. Nothing was charged.");
        return;
      }
      try {
        await factory({ mode: handoff.mode === "live" ? "production" : "sandbox" }).checkout({
          paymentSessionId: handoff.sessionId,
          redirectTarget: "_self",
        });
      } catch {
        events.onUnavailable("Cashfree could not open. Nothing was charged.");
      }
      return;
    }

    /* PayPal, and anything else hosted. Only an https URL the server
       produced is followed — never one assembled in the browser. */
    case "redirect": {
      const target = order.handoff.url;
      if (!/^https:\/\//i.test(target)) {
        events.onUnavailable("The payment provider returned an unexpected address. Nothing was charged.");
        return;
      }
      window.location.assign(target);
      return;
    }
  }
}
