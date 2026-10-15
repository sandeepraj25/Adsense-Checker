import { getSessionUser } from "@/lib/auth/session";
import { isBillingCycle } from "@/lib/billing/cycle";
import { yearlyOffer } from "@/lib/billing/offer";
import { yearlyBillingEnabled } from "@/lib/billing/yearly-settings";
import { getActiveSubscription, setNextBillingCycle } from "@/lib/db/billing";
import { accountBlock } from "@/lib/entitlement";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";
import { getPlan } from "@/lib/plan-catalogue";
import { rateLimit } from "@/lib/rate-limit";
import { siteCurrency } from "@/lib/site-currency";

export const runtime = "nodejs";

/**
 * Schedules the billing cycle for the signed-in account's next renewal,
 * or clears it ({ cycle: null }). Nothing is charged and the period
 * already paid for is not changed: plans don't renew automatically, so
 * the choice becomes the default on the renewal checkout.
 *
 * Yearly can only be scheduled for a paid plan that is offered yearly in
 * the site currency right now.
 */
export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!session) return jsonError("UNAUTHENTICATED", "Log in to change your billing.");
  const blocked = accountBlock(session.user);
  if (blocked) return jsonError(blocked.code, blocked.message);
  if (!rateLimit(`billing-cycle:${session.user.id}`, 20, 60 * 60 * 1000).ok) {
    return jsonError("RATE_LIMITED", "Too many changes. Try again later.");
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  const cycle = body.cycle === null ? null : isBillingCycle(body.cycle) ? body.cycle : undefined;
  if (cycle === undefined) return jsonError("VALIDATION_ERROR", "Choose monthly, yearly or null.");

  try {
    const subscription = getActiveSubscription(session.user.id);
    if (!subscription || subscription.paymentStatus !== "paid") {
      return jsonError("NO_ACTIVE_PLAN", "You need an active paid plan to schedule a billing change.");
    }
    const plan = getPlan(subscription.planId);
    if (cycle === "yearly" && (!plan || !yearlyOffer(plan, siteCurrency(), yearlyBillingEnabled()))) {
      return jsonError("PRICE_NOT_CONFIGURED", `The ${subscription.planName} plan isn't offered yearly right now.`);
    }
    // Scheduling the cycle you already have is the same as clearing it.
    const next = cycle === subscription.billingCycle ? null : cycle;
    if (!setNextBillingCycle({ subscriptionId: subscription.id, userId: session.user.id, cycle: next })) {
      return jsonError("CONFLICT", "Your plan changed meanwhile. Reload the page.");
    }
    return jsonOk({ nextBillingCycle: next, renewsOn: subscription.expiresAt });
  } catch (error) {
    return jsonServerError("account/billing-cycle", error);
  }
}
