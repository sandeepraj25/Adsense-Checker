import { saveCheckoutProgress } from "@/lib/alerts/checkout";
import { optionalUser } from "@/lib/auth/guard";
import { validateBillingOnServer } from "@/lib/billing-details-server";
import { accountBlock } from "@/lib/entitlement";
import { jsonError, jsonOk, jsonServerError, readJson, str } from "@/lib/http";
import { siteCurrency } from "@/lib/site-currency";
import { getPlan } from "@/lib/plan-catalogue";
import type { BillingCycle } from "@/lib/billing/cycle";
import { cyclePrice } from "@/lib/billing/offer";
import { yearlyBillingEnabled } from "@/lib/billing/yearly-settings";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { requestContext, trackServerEvent } from "@/lib/analytics/store";

export const runtime = "nodejs";

/**
 * Saves checkout progress: the billing details a signed-in customer has
 * finished entering, before they press Pay. The checkout form calls this
 * once the details are complete and valid (debounced — not per keystroke).
 *
 * Only details that pass the same server validation as the order route
 * are stored; anything incomplete is refused and nothing is written. The
 * amount comes from the plan catalogue for the chosen currency. Nothing
 * here opens an order, charges anything or grants a plan.
 *
 * Body: { checkoutId?, planId, currency, billing: { name, email, country, phone } }
 */
export async function POST(request: Request) {
  const user = await optionalUser();
  if (!user) return jsonError("UNAUTHENTICATED", "Log in to continue to payment.");
  const blocked = accountBlock(user);
  if (blocked) return jsonError(blocked.code, blocked.message);

  if (!rateLimit(`checkout-progress:${user.id}`, 30, 10 * 60_000).ok) {
    return jsonError("RATE_LIMITED", "Too many updates. Try again shortly.");
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const plan = getPlan(str(body.planId));
  if (!plan || !plan.active || !plan.purchasable) {
    return jsonError("VALIDATION_ERROR", "Choose one of the listed plans.");
  }
  // Saved in the site currency; the browser's value is not used.
  const currency = siteCurrency();
  const billingCycle: BillingCycle = body.billingCycle === "yearly" ? "yearly" : "monthly";
  const amount = cyclePrice(plan, currency, billingCycle, yearlyBillingEnabled());
  if (amount === null || amount <= 0) {
    return jsonError("PRICE_NOT_CONFIGURED", "That plan can't be bought right now.");
  }

  const raw =
    body.billing && typeof body.billing === "object" && !Array.isArray(body.billing)
      ? (body.billing as Record<string, unknown>)
      : {};
  const billing = validateBillingOnServer(raw);
  if (!billing.ok) {
    return jsonError("VALIDATION_ERROR", "Billing details are incomplete.", {
      fields: billing.errors as Record<string, string>,
    });
  }

  try {
    const session = saveCheckoutProgress({
      checkoutId: body.checkoutId,
      userId: user.id,
      plan: { id: plan.id, name: billingCycle === "yearly" ? `${plan.name} (yearly)` : plan.name },
      currency,
      amountMinor: amount,
      billing: billing.details,
    });
    trackServerEvent("checkout_details_saved", {
      key: `details:${session.id}`,
      userId: user.id,
      props: { plan: plan.id, currency },
      context: requestContext(request, clientIp(request)),
    });
    return jsonOk({ checkoutId: session.id, savedAt: session.detailsSavedAt });
  } catch (error) {
    return jsonServerError("checkout/progress", error);
  }
}
