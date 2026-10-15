import {
  gatewayFetch,
  pick,
  pickNumber,
  pickString,
  type CurrencySupportMap,
  type Gateway,
  type GatewayConfig,
  type GatewayCredentials,
  type OrderRequest,
  type OrderResult,
  type VerifyResult,
  type WebhookVerdict,
} from "./types";
import { CURRENCIES, minorToDecimalString, parseMajorToMinor } from "@/lib/money";

/**
 * PayPal Orders v2, for customers outside India.
 *
 * Two honest complications, both surfaced rather than papered over.
 *
 * PayPal's REST currency list does not include INR, so PayPal is offered
 * only in its settlement currency (USD by default), and it charges the
 * plan's own USD price — set by an admin, never converted from rupees.
 * Orders opened before USD prices existed were converted with an
 * admin-maintained rate; those are recognised by their two-part
 * `custom_id` and settled exactly as before, so an order in flight across
 * the upgrade is not stranded.
 *
 * And there is no HMAC to check. PayPal verifies a webhook by having you
 * ask PayPal, so `verifyWebhook` makes a server-to-server call to the
 * verification endpoint. A deployment without PAYPAL_WEBHOOK_ID cannot
 * verify anything, and unverified deliveries are rejected rather than
 * trusted.
 */

function base(config: GatewayConfig): string {
  return config.environment === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function basicAuth(config: GatewayConfig): string {
  const raw = `${config.credentials.clientId ?? ""}:${config.credentials.clientSecret ?? ""}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/**
 * Access tokens last hours; caching one avoids an OAuth round trip on
 * every checkout. Keyed by client id and environment so switching either
 * cannot serve a token minted for the other.
 */
const tokens = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(config: GatewayConfig): Promise<string> {
  const key = `${config.environment}:${config.credentials.clientId ?? ""}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const response = await gatewayFetch("paypal", `${base(config)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basicAuth(config) },
    form: { grant_type: "client_credentials" },
  });

  const token = pickString(response.json, "access_token");
  if (!response.ok || !token) {
    throw new Error(
      pickString(response.json, "error_description") ??
        `PayPal refused the credentials (${response.status}).`,
    );
  }

  const ttl = pickNumber(response.json, "expires_in") ?? 3_000;
  tokens.set(key, { token, expiresAt: Date.now() + ttl * 1_000 });
  return token;
}

function settlementCurrency(credentials: GatewayCredentials): string {
  const raw = (credentials.currency ?? "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : "USD";
}

/** USD when PayPal settles in USD; never INR (not in PayPal's list). */
function paypalCurrencySupport(credentials: GatewayCredentials): CurrencySupportMap {
  const settlement = settlementCurrency(credentials);
  const out = {} as CurrencySupportMap;
  for (const code of CURRENCIES) {
    if (code === "INR") {
      out[code] = {
        available: false,
        basis: "unsupported",
        reason: "PayPal's supported-currency list doesn't include INR, so rupee prices are not sent to PayPal.",
      };
    } else if (code === settlement) {
      out[code] = {
        available: true,
        basis: "settlement",
        reason: `PayPal is set to charge in ${code}. It charges the plan's ${code} price.`,
      };
    } else {
      out[code] = {
        available: false,
        basis: "unsupported",
        reason: `PayPal is set to charge in ${settlement}, which this site has no prices in. Set the settlement currency to ${code}.`,
      };
    }
  }
  return out;
}

/**
 * `custom_id` is `user:plan:currency` on orders opened since prices got a
 * currency; the old two-part form marks an order whose amount was
 * converted from rupees, which our row records in INR.
 */
function isLegacyConvertedOrder(customId: string | null): boolean {
  // Missing is treated like legacy: no cross-check is better than
  // refusing a payment PayPal really captured. The ordered-vs-captured
  // comparison still runs either way.
  return customId === null || customId.split(":").length === 2;
}

/** What to cross-check against our row: real minor units, or nothing for legacy orders. */
function observed(customId: string | null, value: string | null, currency: string | null) {
  if (isLegacyConvertedOrder(customId)) {
    return { amountPaise: currency === "INR" ? parseMajorToMinor(value) : null, currency: currency === "INR" ? currency : null };
  }
  return { amountPaise: parseMajorToMinor(value), currency };
}

export const paypal: Gateway = {
  id: "paypal",
  label: "PayPal",
  blurb: "Cards and PayPal balance, for customers paying from outside India.",
  methods: ["PayPal balance", "International cards"],

  fields: [
    {
      key: "clientId",
      label: "Client ID",
      hint: "PayPal Developer Dashboard → Apps & Credentials. Public; appears in the redirect.",
      secret: false,
    },
    {
      key: "clientSecret",
      label: "Client Secret",
      hint: "The other half of the app credentials. Used only server-side, for OAuth.",
      secret: true,
    },
    {
      key: "webhookId",
      label: "Webhook ID",
      hint: "The ID of the webhook you registered. Without it, deliveries cannot be verified and are rejected.",
      secret: false,
      optional: true,
    },
    {
      key: "currency",
      label: "Settlement currency",
      hint: "USD unless your PayPal account settles in something else. PayPal charges each plan's USD price from Admin → Pricing — rupee prices are never converted.",
      secret: false,
      optional: true,
    },
  ],

  isConfigured(credentials) {
    return Boolean(credentials.clientId && credentials.clientSecret);
  },

  currencySupport(credentials) {
    return paypalCurrencySupport(credentials);
  },

  async createOrder(
    config: GatewayConfig,
    request: OrderRequest,
  ): Promise<OrderResult> {
    // Checkout only routes a currency here that currencySupport allowed;
    // this is the adapter refusing to be the place that guesses.
    const settlement = settlementCurrency(config.credentials);
    if (request.currency !== settlement) {
      throw new Error(
        `PayPal is set up to charge in ${settlement}, not ${request.currency}. Choose another payment method.`,
      );
    }
    const token = await accessToken(config);
    const money = { currency: request.currency, value: minorToDecimalString(request.amountPaise) };

    const response = await gatewayFetch(
      "paypal",
      `${base(config)}/v2/checkout/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          // PayPal deduplicates on this, so a double-submitted checkout
          // opens one order rather than two.
          "PayPal-Request-Id": request.receipt,
        },
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: request.receipt,
              custom_id: `${request.userId}:${request.planId}:${request.currency}`,
              description: `${request.planName} plan — ${request.billingCycle === "yearly" ? "12 months" : "1 month"}`,
              amount: {
                currency_code: money.currency,
                value: money.value,
              },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                user_action: "PAY_NOW",
                return_url: request.returnUrl,
                cancel_url: `${request.returnUrl}?cancelled=1`,
              },
            },
          },
        },
      },
    );

    const orderId = pickString(response.json, "id");
    if (!response.ok || !orderId) {
      throw new Error(
        pickString(response.json, "message") ??
          `PayPal returned ${response.status}`,
      );
    }

    const links = pick(response.json, "links");
    const approve = Array.isArray(links)
      ? links.find((link) => {
          const rel = pickString(link, "rel");
          return rel === "payer-action" || rel === "approve";
        })
      : null;
    const url = pickString(approve, "href");
    if (!url) {
      throw new Error("PayPal did not return an approval link.");
    }

    return { orderId, handoff: { kind: "redirect", url } };
  },

  /**
   * The capture call *is* the verification: it is a server-to-server
   * request authenticated with our own client credentials, so the browser
   * cannot fake its result. The requested and captured amounts are then
   * compared, which catches a payer who approved a different figure.
   */
  async verifyReturn(
    config: GatewayConfig,
    payload: Record<string, unknown>,
  ): Promise<VerifyResult> {
    const orderId = pickString(payload, "token") ?? pickString(payload, "order_id");
    if (!orderId) {
      return {
        ok: false,
        kind: "rejected",
        message: "The payment response named no order.",
      };
    }

    const token = await accessToken(config);
    const response = await gatewayFetch(
      "paypal",
      `${base(config)}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "PayPal-Request-Id": `capture_${orderId}`,
        },
        body: {},
      },
    );

    // A previously-captured order comes back as a 422 with this issue.
    // That is not an error: it means somebody already completed this, and
    // fulfilment is idempotent, so read the capture and carry on.
    const issue = pickString(response.json, "details", "0", "issue");
    if (!response.ok && issue !== "ORDER_ALREADY_CAPTURED") {
      const detail = pickString(response.json, "details", "0", "description");
      return {
        ok: false,
        kind:
          issue === "INSTRUMENT_DECLINED" || issue === "PAYER_ACTION_REQUIRED"
            ? "rejected"
            : "error",
        // A declined card is PayPal's verdict; "payer action required" is not a failure.
        providerConfirmed: issue === "INSTRUMENT_DECLINED",
        message:
          detail ??
          pickString(response.json, "message") ??
          "PayPal could not complete the payment.",
      };
    }

    const status = pickString(response.json, "status");
    if (status && status !== "COMPLETED" && status !== "APPROVED") {
      return {
        ok: false,
        kind: status === "VOIDED" ? "cancelled" : "pending",
        message:
          status === "VOIDED"
            ? "That PayPal order was cancelled."
            : "PayPal has not completed this payment yet.",
      };
    }

    const unit = pick(response.json, "purchase_units", "0");
    const capture = pick(unit, "payments", "captures", "0");
    const captureId = pickString(capture, "id");
    if (!captureId) {
      return {
        ok: false,
        kind: "pending",
        message: "PayPal approved the order but has not captured it yet.",
      };
    }

    const requested = pickNumber(unit, "amount", "value");
    const taken = pickNumber(capture, "amount", "value");
    if (requested !== null && taken !== null && Math.abs(requested - taken) > 0.001) {
      return {
        ok: false,
        kind: "rejected",
        message: "The amount captured does not match the amount ordered.",
      };
    }

    // Current orders are charged in the currency our row records, so the
    // captured amount is handed back for fulfilment's own cross-check.
    // Legacy converted orders (two-part custom_id) keep the old rule:
    // ordered-against-captured, above, is the comparison that applies.
    const currency = pickString(capture, "amount", "currency_code");
    const customId = pickString(capture, "custom_id") ?? pickString(unit, "custom_id");
    const seen = observed(customId, pickString(capture, "amount", "value"), currency);

    return {
      ok: true,
      orderId,
      gatewayPaymentId: captureId,
      method: "paypal",
      amountPaise: seen.amountPaise,
      currency: seen.currency,
      rawStatus: `${pickString(capture, "status") ?? status ?? "COMPLETED"} · ${taken ?? "?"} ${currency ?? "?"}`,
    };
  },

  /**
   * PayPal has no signing secret to compare against. Verification is a
   * call to their own endpoint with the delivery's headers and body; if
   * that does not answer SUCCESS, the delivery is rejected.
   */
  async verifyWebhook(
    config: GatewayConfig,
    rawBody: string,
    requestHeaders: Headers,
  ): Promise<WebhookVerdict> {
    const webhookId = config.credentials.webhookId ?? "";
    if (!webhookId) {
      return {
        ok: false,
        kind: "unsigned",
        message:
          "No PayPal webhook ID is configured, so deliveries cannot be verified.",
      };
    }

    const required = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];
    const present: Record<string, string> = {};
    for (const name of required) {
      const value = requestHeaders.get(name);
      if (!value) {
        return {
          ok: false,
          kind: "unsigned",
          message: `The delivery was missing ${name}.`,
        };
      }
      present[name] = value;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, kind: "malformed", message: "The body was not JSON." };
    }

    let token: string;
    try {
      token = await accessToken(config);
    } catch {
      return {
        ok: false,
        kind: "invalid",
        message: "PayPal credentials were rejected while verifying a webhook.",
      };
    }

    const check = await gatewayFetch(
      "paypal",
      `${base(config)}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: {
          auth_algo: present["paypal-auth-algo"],
          cert_url: present["paypal-cert-url"],
          transmission_id: present["paypal-transmission-id"],
          transmission_sig: present["paypal-transmission-sig"],
          transmission_time: present["paypal-transmission-time"],
          webhook_id: webhookId,
          // Must be the parsed body: PayPal re-serialises it their way.
          webhook_event: body,
        },
      },
    );

    if (!check.ok || pickString(check.json, "verification_status") !== "SUCCESS") {
      return {
        ok: false,
        kind: "invalid",
        message: "PayPal did not confirm the webhook signature.",
      };
    }

    const eventType = pickString(body, "event_type") ?? "unknown";
    const eventId = pickString(body, "id") ?? present["paypal-transmission-id"];
    const resource = pick(body, "resource");

    // A capture's `supplementary_data` carries the order it belongs to.
    const orderId =
      pickString(
        resource,
        "supplementary_data",
        "related_ids",
        "order_id",
      ) ?? pickString(resource, "id");
    const captureId = pickString(resource, "id");
    const currency = pickString(resource, "amount", "currency_code");
    const value = pickNumber(resource, "amount", "value");
    const seen = observed(
      pickString(resource, "custom_id"),
      pickString(resource, "amount", "value"),
      currency,
    );

    const completed = eventType === "PAYMENT.CAPTURE.COMPLETED";
    const failed =
      eventType === "PAYMENT.CAPTURE.DENIED" ||
      eventType === "PAYMENT.CAPTURE.REVERSED" ||
      eventType === "CHECKOUT.ORDER.VOIDED";

    return {
      ok: true,
      eventId,
      eventType,
      payment:
        completed && orderId && captureId
          ? {
              orderId,
              gatewayPaymentId: captureId,
              method: "paypal",
              amountPaise: seen.amountPaise,
              currency: seen.currency,
              rawStatus: `${pickString(resource, "status") ?? "COMPLETED"} · ${value ?? "?"} ${currency ?? "?"}`,
            }
          : null,
      failure:
        failed && orderId
          ? {
              orderId,
              reason:
                eventType === "CHECKOUT.ORDER.VOIDED"
                  ? "The PayPal order was cancelled."
                  : "PayPal denied or reversed the capture.",
            }
          : null,
    };
  },
};
