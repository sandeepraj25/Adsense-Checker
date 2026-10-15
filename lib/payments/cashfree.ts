import { createHmac } from "node:crypto";

import { safeEqual } from "@/lib/secrets";

import {
  gatewayFetch,
  pick,
  pickNumber,
  pickString,
  declaredCurrencySupport,
  extraCurrenciesField,
  type Gateway,
  type GatewayConfig,
  type OrderRequest,
  type OrderResult,
  type VerifyResult,
  type WebhookVerdict,
} from "./types";
import { minorToDecimalString } from "@/lib/money";

/**
 * Cashfree Payment Gateway, API version 2023-08-01.
 *
 * Two things differ from Razorpay and both are handled here rather than
 * leaked upwards. Cashfree prices in *rupees* as a decimal string, so the
 * paise figure is converted on the way out and back again on the way in.
 * And it has no browser-side signature: the return trip carries only an
 * order id, so verification means reading the order back from the API,
 * which is stronger than a signature anyway because it cannot be replayed
 * from a stale success.
 */

function base(config: GatewayConfig): string {
  return config.environment === "live"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

function headers(config: GatewayConfig): Record<string, string> {
  return {
    "x-client-id": config.credentials.appId ?? "",
    "x-client-secret": config.credentials.secretKey ?? "",
    "x-api-version": "2023-08-01",
  };
}

/** 39900 → "399.00" (and 599 cents → "5.99"). Integer maths, no float. */
function toMajor(amountMinor: number): string {
  return minorToDecimalString(amountMinor);
}

/** "399.00" → 39900, for the cross-check against our own record. */
function toPaise(amount: number | null): number | null {
  return amount === null ? null : Math.round(amount * 100);
}

export const cashfree: Gateway = {
  id: "cashfree",
  label: "Cashfree",
  blurb: "UPI, cards, net banking and pay-later, billed in rupees.",
  methods: ["UPI", "Cards", "Net banking", "Pay later"],

  fields: [
    {
      key: "appId",
      label: "App ID",
      hint: "Cashfree Dashboard → Developers → API Keys. Also called the Client ID.",
      secret: false,
    },
    {
      key: "secretKey",
      label: "Secret Key",
      hint: "The other half of the API key pair. Also verifies webhook signatures.",
      secret: true,
    },
    {
      key: "webhookSecret",
      label: "Webhook Secret",
      hint: "Optional. Leave blank to verify webhooks with the Secret Key, which is what Cashfree signs with by default.",
      secret: true,
      optional: true,
    },
    extraCurrenciesField("Cashfree"),
  ],

  isConfigured(credentials) {
    return Boolean(credentials.appId && credentials.secretKey);
  },

  // Cashfree's currency list says "By default, only INR is available" —
  // other currencies are enabled by Cashfree on request.
  currencySupport(credentials) {
    return declaredCurrencySupport("Cashfree", credentials);
  },

  async createOrder(
    config: GatewayConfig,
    request: OrderRequest,
  ): Promise<OrderResult> {
    if (!request.customerPhone) {
      throw new Error(
        "Cashfree needs a contact number on the order. Add a phone number and try again.",
      );
    }

    // Our own id, so the return trip and the webhook both name an order we
    // can look up without a second mapping table.
    const orderId = `cf_${request.receipt}`;

    const response = await gatewayFetch("cashfree", `${base(config)}/orders`, {
      method: "POST",
      headers: headers(config),
      body: {
        order_id: orderId,
        order_amount: toMajor(request.amountPaise),
        order_currency: request.currency,
        customer_details: {
          customer_id: request.userId,
          customer_name: request.customerName,
          customer_email: request.customerEmail,
          customer_phone: request.customerPhone,
        },
        order_meta: { return_url: `${request.returnUrl}?order_id={order_id}` },
        order_note: `${request.planName} plan — ${request.billingCycle === "yearly" ? "yearly" : "monthly"}`,
      },
    });

    const sessionId = pickString(response.json, "payment_session_id");
    if (!response.ok || !sessionId) {
      throw new Error(
        pickString(response.json, "message") ??
          `Cashfree returned ${response.status}`,
      );
    }

    return {
      orderId,
      handoff: {
        kind: "cashfree_session",
        sessionId,
        mode: config.environment,
      },
    };
  },

  /**
   * No signature to check, so the order is read back from Cashfree and the
   * payment list is scanned for a successful capture. Nothing the browser
   * sent is trusted beyond the order id it names, and even that is only
   * used as a lookup key.
   */
  async verifyReturn(
    config: GatewayConfig,
    payload: Record<string, unknown>,
  ): Promise<VerifyResult> {
    const orderId = pickString(payload, "order_id");
    if (!orderId) {
      return {
        ok: false,
        kind: "rejected",
        message: "The payment response named no order.",
      };
    }

    const order = await gatewayFetch(
      "cashfree",
      `${base(config)}/orders/${encodeURIComponent(orderId)}`,
      { headers: headers(config) },
    );
    if (!order.ok) {
      return {
        ok: false,
        kind: "error",
        message: "The order could not be confirmed with Cashfree.",
      };
    }

    const status = pickString(order.json, "order_status");
    if (status !== "PAID") {
      return {
        ok: false,
        kind:
          status === "ACTIVE"
            ? "pending"
            : status === "EXPIRED"
              ? "cancelled"
              : "rejected",
        // Cashfree's own order status (e.g. TERMINATED) — not our check.
        providerConfirmed: status !== "ACTIVE" && status !== "EXPIRED" && Boolean(status),
        message:
          status === "ACTIVE"
            ? "Cashfree has not confirmed this payment yet."
            : status === "EXPIRED"
              ? "That payment session expired before it completed."
              : "Cashfree did not report this order as paid.",
      };
    }

    const payments = await gatewayFetch(
      "cashfree",
      `${base(config)}/orders/${encodeURIComponent(orderId)}/payments`,
      { headers: headers(config) },
    );
    const list = Array.isArray(payments.json) ? payments.json : [];
    const success = list.find(
      (entry) => pickString(entry, "payment_status") === "SUCCESS",
    );

    if (!success) {
      return {
        ok: false,
        kind: "pending",
        message:
          "Cashfree marked the order paid but has not settled a payment against it yet.",
      };
    }

    const paymentId =
      pickString(success, "cf_payment_id") ??
      String(pickNumber(success, "cf_payment_id") ?? "");
    if (!paymentId) {
      return {
        ok: false,
        kind: "error",
        message: "Cashfree returned a payment without an identifier.",
      };
    }

    return {
      ok: true,
      orderId,
      gatewayPaymentId: paymentId,
      method: describeMethod(pick(success, "payment_method")),
      amountPaise: toPaise(pickNumber(success, "payment_amount")),
      currency: pickString(success, "payment_currency"),
      rawStatus: pickString(success, "payment_status"),
    };
  },

  /**
   * Cashfree signs `timestamp + rawBody` with the secret key and sends the
   * result base64 in `x-webhook-signature`. The timestamp is part of the
   * signed material, so a delivery cannot be replayed under a different
   * one.
   */
  async verifyWebhook(
    config: GatewayConfig,
    rawBody: string,
    requestHeaders: Headers,
  ): Promise<WebhookVerdict> {
    const secret =
      config.credentials.webhookSecret || config.credentials.secretKey || "";
    const signature = requestHeaders.get("x-webhook-signature") ?? "";
    const timestamp = requestHeaders.get("x-webhook-timestamp") ?? "";

    if (!secret) {
      return {
        ok: false,
        kind: "unsigned",
        message: "No secret is configured for Cashfree.",
      };
    }
    if (!signature || !timestamp) {
      return {
        ok: false,
        kind: "unsigned",
        message: "The delivery carried no signature or timestamp.",
      };
    }

    const expected = createHmac("sha256", secret)
      .update(timestamp + rawBody)
      .digest("base64");
    if (!safeEqual(expected, signature)) {
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

    const eventType = pickString(body, "type") ?? "unknown";
    const orderId = pickString(body, "data", "order", "order_id");
    const paymentId =
      pickString(body, "data", "payment", "cf_payment_id") ??
      (pickNumber(body, "data", "payment", "cf_payment_id") !== null
        ? String(pickNumber(body, "data", "payment", "cf_payment_id"))
        : null);

    // Cashfree sends no event id, so the idempotency key is composed from
    // the event type, the payment and the signed timestamp — which is
    // stable across a redelivery of the same event and distinct between
    // genuinely different ones.
    const eventId = `cashfree:${eventType}:${paymentId ?? orderId ?? timestamp}`;

    const paid =
      eventType === "PAYMENT_SUCCESS_WEBHOOK" &&
      pickString(body, "data", "payment", "payment_status") === "SUCCESS";
    const failed =
      eventType === "PAYMENT_FAILED_WEBHOOK" ||
      eventType === "PAYMENT_USER_DROPPED_WEBHOOK";

    return {
      ok: true,
      eventId,
      eventType,
      payment:
        paid && orderId && paymentId
          ? {
              orderId,
              gatewayPaymentId: paymentId,
              method: describeMethod(pick(body, "data", "payment", "payment_method")),
              amountPaise: toPaise(
                pickNumber(body, "data", "payment", "payment_amount"),
              ),
              currency: pickString(body, "data", "payment", "payment_currency"),
              rawStatus: pickString(body, "data", "payment", "payment_status"),
            }
          : null,
      failure:
        failed && orderId
          ? {
              orderId,
              reason:
                pickString(body, "data", "error_details", "error_description") ??
                (eventType === "PAYMENT_USER_DROPPED_WEBHOOK"
                  ? "The payment was abandoned before it completed."
                  : "Cashfree reported the payment as failed."),
            }
          : null,
    };
  },
};

/**
 * Cashfree reports the method as an object keyed by its type — `{ upi:
 * {...} }`, `{ card: {...} }`. The key is the useful part; the contents
 * are card and VPA detail we have no business storing.
 */
function describeMethod(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 ? keys[0] : null;
}
