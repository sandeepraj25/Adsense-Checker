import { createHmac } from "node:crypto";

import { safeEqual } from "@/lib/secrets";

import {
  gatewayFetch,
  pickNumber,
  pickString,
  declaredCurrencySupport,
  extraCurrenciesField,
  type Gateway,
  type GatewayConfig,
  type GatewayCredentials,
  type OrderRequest,
  type OrderResult,
  type VerifyResult,
  type WebhookVerdict,
} from "./types";

/**
 * Razorpay: UPI, cards and net banking, priced in paise.
 *
 * Three REST calls and two HMACs, so this talks to the API over `fetch`
 * rather than pulling in the SDK. The key *id* is public — Razorpay
 * Checkout needs it in the browser — and the key secret never leaves the
 * server.
 */

const API = "https://api.razorpay.com/v1";

export const RAZORPAY_CHECKOUT_SCRIPT =
  "https://checkout.razorpay.com/v1/checkout.js";

function auth(credentials: GatewayCredentials): string {
  const raw = `${credentials.keyId ?? ""}:${credentials.keySecret ?? ""}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export const razorpay: Gateway = {
  id: "razorpay",
  label: "Razorpay",
  blurb: "UPI, cards, net banking and wallets, billed in rupees.",
  methods: ["UPI", "Cards", "Net banking", "Wallets"],

  fields: [
    {
      key: "keyId",
      label: "Key ID",
      hint: "Razorpay Dashboard → Settings → API Keys. Starts rzp_test_ or rzp_live_.",
      secret: false,
    },
    {
      key: "keySecret",
      label: "Key Secret",
      hint: "Shown once when the key pair is generated. Signs the checkout handshake.",
      secret: true,
    },
    {
      key: "webhookSecret",
      label: "Webhook Secret",
      hint: "Settings → Webhooks. Without it, webhook deliveries are rejected unverified.",
      secret: true,
      optional: true,
    },
    extraCurrenciesField("Razorpay"),
  ],

  isConfigured(credentials) {
    return Boolean(credentials.keyId && credentials.keySecret);
  },

  // Razorpay takes `currency` on the order with the amount in that
  // currency's subunit (cents for USD), but only for accounts with
  // international payments activated.
  currencySupport(credentials) {
    return declaredCurrencySupport("Razorpay", credentials);
  },

  async createOrder(
    config: GatewayConfig,
    request: OrderRequest,
  ): Promise<OrderResult> {
    const response = await gatewayFetch("razorpay", `${API}/orders`, {
      method: "POST",
      headers: { Authorization: auth(config.credentials) },
      body: {
        amount: request.amountPaise,
        currency: request.currency,
        receipt: request.receipt,
        // Razorpay only captures automatically when told to; without this
        // a successful payment sits authorised and expires uncaptured.
        payment_capture: 1,
        notes: {
          userId: request.userId,
          planId: request.planId,
          planName: request.planName,
        },
      },
    });

    const orderId = pickString(response.json, "id");
    if (!response.ok || !orderId) {
      throw new Error(
        pickString(response.json, "error", "description") ??
          `Razorpay returned ${response.status}`,
      );
    }

    return {
      orderId,
      handoff: {
        kind: "razorpay_checkout",
        keyId: config.credentials.keyId ?? "",
        orderId,
      },
    };
  },

  /**
   * The checkout handshake. Razorpay signs `order_id|payment_id` with the
   * key secret, which a browser cannot forge — that is what makes this
   * worth more than the client's claim that the payment succeeded. The
   * payment is then read back from the API so the amount and status come
   * from Razorpay rather than from the callback.
   */
  async verifyReturn(
    config: GatewayConfig,
    payload: Record<string, unknown>,
  ): Promise<VerifyResult> {
    const orderId = pickString(payload, "razorpay_order_id");
    const paymentId = pickString(payload, "razorpay_payment_id");
    const signature = pickString(payload, "razorpay_signature");
    const secret = config.credentials.keySecret ?? "";

    if (!orderId || !paymentId || !signature) {
      return {
        ok: false,
        kind: "rejected",
        message: "The payment response was incomplete.",
      };
    }
    if (!secret) {
      return {
        ok: false,
        kind: "error",
        message: "Razorpay is not configured on this deployment.",
      };
    }
    if (!safeEqual(hmacHex(secret, `${orderId}|${paymentId}`), signature)) {
      return {
        ok: false,
        kind: "rejected",
        message: "The payment signature did not verify.",
      };
    }

    const read = await gatewayFetch(
      "razorpay",
      `${API}/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: auth(config.credentials) } },
    );
    if (!read.ok) {
      return {
        ok: false,
        kind: "error",
        message: "The payment could not be confirmed with Razorpay.",
      };
    }

    const status = pickString(read.json, "status");
    if (status !== "captured" && status !== "authorized") {
      return {
        ok: false,
        kind: status === "failed" ? "rejected" : "pending",
        providerConfirmed: status === "failed",
        message:
          status === "failed"
            ? pickString(read.json, "error_description") ??
              "Razorpay reported the payment as failed."
            : "Razorpay has not confirmed this payment yet.",
      };
    }
    // The signature proves this payment belongs to *a* Razorpay order; this
    // proves it belongs to the one we opened.
    if (pickString(read.json, "order_id") !== orderId) {
      return {
        ok: false,
        kind: "rejected",
        message: "That payment belongs to a different order.",
      };
    }

    return {
      ok: true,
      orderId,
      gatewayPaymentId: paymentId,
      method: pickString(read.json, "method"),
      amountPaise: pickNumber(read.json, "amount"),
      currency: pickString(read.json, "currency"),
      rawStatus: status,
    };
  },

  async verifyWebhook(
    config: GatewayConfig,
    rawBody: string,
    headers: Headers,
  ): Promise<WebhookVerdict> {
    const secret = config.credentials.webhookSecret ?? "";
    const signature = headers.get("x-razorpay-signature") ?? "";

    if (!secret) {
      return {
        ok: false,
        kind: "unsigned",
        message: "No webhook secret is configured for Razorpay.",
      };
    }
    if (!signature) {
      return {
        ok: false,
        kind: "unsigned",
        message: "The delivery carried no signature.",
      };
    }
    // Signed over the exact bytes, so the raw body must not be reparsed
    // and re-serialised before this point.
    if (!safeEqual(hmacHex(secret, rawBody), signature)) {
      return {
        ok: false,
        kind: "invalid",
        message: "The webhook signature did not verify.",
      };
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, kind: "malformed", message: "The body was not JSON." };
    }

    const eventType = pickString(body, "event") ?? "unknown";
    const orderId = pickString(body, "payload", "payment", "entity", "order_id");
    const paymentId = pickString(body, "payload", "payment", "entity", "id");

    // Razorpay's own delivery id. Preferred as the idempotency key; when a
    // proxy strips it, the payment id plus event type is still unique per
    // meaningful event.
    const eventId =
      headers.get("x-razorpay-event-id") ??
      (paymentId ? `${eventType}:${paymentId}` : `${eventType}:${rawBody.length}`);

    const captured =
      eventType === "payment.captured" || eventType === "order.paid";
    const failed = eventType === "payment.failed";

    return {
      ok: true,
      eventId,
      eventType,
      payment:
        captured && orderId && paymentId
          ? {
              orderId,
              gatewayPaymentId: paymentId,
              method: pickString(body, "payload", "payment", "entity", "method"),
              amountPaise: pickNumber(body, "payload", "payment", "entity", "amount"),
              currency: pickString(body, "payload", "payment", "entity", "currency"),
              rawStatus: pickString(body, "payload", "payment", "entity", "status"),
            }
          : null,
      failure:
        failed && orderId
          ? {
              orderId,
              reason:
                pickString(
                  body,
                  "payload",
                  "payment",
                  "entity",
                  "error_description",
                ) ?? "Razorpay reported the payment as failed.",
            }
          : null,
    };
  },
};
