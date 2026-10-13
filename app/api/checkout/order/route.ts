import { optionalUser } from "@/lib/auth/guard";
import { validateBillingOnServer } from "@/lib/billing-details-server";
import { accountBlock } from "@/lib/entitlement";
import { jsonError, jsonOk, jsonServerError, readJson, str } from "@/lib/http";
import { checkoutOptions, checkoutReturnUrl, startCheckout } from "@/lib/payments";
import { parseCurrency } from "@/lib/money";
import { planPrice } from "@/lib/plans";
import { siteCurrency } from "@/lib/site-currency";
import { markPaymentStarted } from "@/lib/alerts/checkout";
import { getPlan } from "@/lib/plan-catalogue";
import { isGatewayId } from "@/lib/db/types";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { requestContext, trackServerEvent } from "@/lib/analytics/store";

export const runtime = "nodejs";

const PRICE_CHANGED_MESSAGE =
  "The price of this plan has changed since you opened this page. Reload to see the current price — nothing has been charged.";

/** A purchase-attempt key from the checkout form: a UUID, nothing else. */
const ATTEMPT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens an order with the chosen gateway.
 *
 * The request names a plan, a currency, a payment method, the customer's
 * billing details and a purchase-attempt key. It never names a price: the amount
 * is read from the plan catalogue on this side, so a crafted body cannot
 * buy Pro for a rupee — any `amount`, `price` or `total` field is simply
 * not read. The currency is the site currency an administrator chose;
 * `currency` and `expectedAmount` in the body are only checked against it,
 * so a page opened before a change can't be charged a different price. What comes back is the minimum the browser needs to open
 * checkout (an order id, a public key, or a redirect URL), never a secret.
 *
 * Order of checks: session → account → rate limit → billing details and
 * attempt id → plan → gateway → duplicate attempt → gateway call.
 */
export async function POST(request: Request) {
  const user = await optionalUser();
  if (!user) {
    return jsonError("UNAUTHENTICATED", "Log in to continue to payment.");
  }

  const blocked = accountBlock(user);
  if (blocked) return jsonError(blocked.code, blocked.message);

  const limit = rateLimit(`order:${user.id}`, 20, 10 * 60 * 1000);
  if (!limit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many checkout attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const rawBilling =
    body.billing && typeof body.billing === "object" && !Array.isArray(body.billing)
      ? (body.billing as Record<string, unknown>)
      : {};
  const billing = validateBillingOnServer(rawBilling);
  if (!billing.ok) {
    return jsonError("VALIDATION_ERROR", "Check the highlighted billing details.", {
      fields: billing.errors as Record<string, string>,
    });
  }

  const attempt = str(body.attemptId);
  if (attempt && !ATTEMPT_KEY.test(attempt)) {
    return jsonError("VALIDATION_ERROR", "Reload the checkout page and try again.");
  }

  const plan = getPlan(str(body.planId));
  if (!plan) {
    return jsonError("VALIDATION_ERROR", "Choose one of the listed plans.");
  }
  if (!plan.active || !plan.purchasable) {
    return jsonError("VALIDATION_ERROR", "That plan cannot be purchased.");
  }

  // The currency is the site's, set by an administrator — never the
  // browser's. What the form sends is only what the customer was shown:
  // if the admin has switched currency or re-priced the plan since the
  // page loaded, the order is refused rather than charged differently.
  const currency = siteCurrency();
  const shownCurrency = body.currency;
  if (shownCurrency !== undefined && shownCurrency !== null && shownCurrency !== "") {
    const parsed = parseCurrency(shownCurrency);
    if (!parsed) return jsonError("CURRENCY_UNSUPPORTED", "That currency isn't accepted.");
    if (parsed !== currency) return jsonError("PRICE_CHANGED", PRICE_CHANGED_MESSAGE, { extra: { currency } });
  }
  const options = checkoutOptions();
  if (options.length === 0) {
    return jsonError(
      "PAYMENTS_UNCONFIGURED",
      "Online payment is unavailable right now. No payment gateway is enabled — please try again later or contact support.",
    );
  }

  // An absent gateway means "whatever you have"; a named one that is off
  // gets a specific refusal rather than a silent substitution.
  const requested = str(body.gateway);
  if (requested && !isGatewayId(requested)) {
    return jsonError("VALIDATION_ERROR", "Choose one of the listed payment methods.");
  }
  const gateway = isGatewayId(requested)
    ? requested
    : (options.find((option) => option.currencies.includes(currency)) ?? options[0]).id;

  // Checked here, in the same order as before: payment availability first.
  const price = planPrice(plan, currency);
  if (price === null || price <= 0) {
    return jsonError("PRICE_NOT_CONFIGURED", `The ${plan.name} plan can't be bought right now. Nothing has been charged.`);
  }
  if (body.expectedAmount !== undefined && body.expectedAmount !== null && body.expectedAmount !== price) {
    return jsonError("PRICE_CHANGED", PRICE_CHANGED_MESSAGE, { extra: { currency } });
  }

  try {
    const result = await startCheckout({
      userId: user.id,
      plan,
      currency,
      gateway,
      customerName: user.name,
      customerEmail: user.email,
      billing: billing.details,
      idempotencyKey: attempt ? attempt.toLowerCase() : undefined,
      // The gateway must send the browser back to the host that holds
      // the (host-only) session cookie, or the return lands logged out.
      returnUrl: checkoutReturnUrl(request),
    });

    // Pay was pressed: whatever the gateway said, this checkout is no
    // longer a candidate for an "abandoned" alert. A pending payment is
    // not an abandonment.
    try {
      markPaymentStarted({
        checkoutId: body.checkoutId,
        userId: user.id,
        planId: plan.id,
        orderId: result.ok ? result.orderId : null,
      });
    } catch (error) {
      console.error("[alerts] could not mark payment started", error instanceof Error ? error.message : error);
    }

    if (!result.ok) {
      return jsonError(result.code, result.message);
    }

    trackServerEvent("payment_attempted", {
      key: `attempt:${result.orderId}`,
      userId: user.id,
      props: { plan: plan.id, currency: result.currency, gateway: result.gateway, mode: result.simulated ? "mock" : "live" },
      context: requestContext(request, clientIp(request)),
    });

    return jsonOk({
      gateway: result.gateway,
      orderId: result.orderId,
      // Minor units of `currency` (paise or cents), as charged.
      amountPaise: result.amountPaise,
      currency: result.currency,
      planId: result.planId,
      planName: result.planName,
      simulated: result.simulated,
      replayed: Boolean(result.replayed),
      // Narrow by construction: an id, a public key, or a redirect. No
      // adapter is able to put a secret in here.
      handoff: result.handoff,
      prefill: {
        name: billing.details.name,
        email: billing.details.email,
        contact: billing.details.phone,
      },
    });
  } catch (error) {
    return jsonServerError("checkout/order", error);
  }
}

/**
 * The payment methods a customer may choose, for rendering the checkout
 * form. Public information only: labels, methods and the sandbox flag.
 */
export async function GET() {
  const user = await optionalUser();
  if (!user) return jsonError("UNAUTHENTICATED", "Log in to continue to payment.");
  return jsonOk({ options: checkoutOptions() });
}
