import { planPrice, type Plan } from "@/lib/plans";

import { monthlyEquivalent, yearlyDiscountPercent, type BillingCycle } from "./cycle";

/**
 * What a plan costs for a billing cycle, in one currency. Pure and
 * browser-safe; the site-wide yearly switch is passed in by the caller
 * (lib/billing/yearly-settings.ts reads it on the server).
 */

type Priced = Pick<Plan, "id" | "amountPaise" | "usdAmountCents" | "yearlyAmountPaise" | "yearlyUsdCents" | "yearlyEnabled" | "yearlyBadge" | "purchasable" | "active">;

export type YearlyOffer = {
  /** Twelve months, in minor units of the currency. */
  price: number;
  /** price ÷ 12, rounded — for "≈ ₹332/month". */
  perMonth: number;
  /** Whole percent saved against twelve monthly payments, or null. */
  discount: number | null;
  badge: string | null;
};

function yearlyConfigured(plan: Priced, currency: string): number | null {
  if (currency === "INR") return plan.yearlyAmountPaise;
  if (currency === "USD") return plan.yearlyUsdCents;
  return null;
}

/**
 * The yearly offer for this plan in this currency, or null when there is
 * none: yearly billing off site-wide or for the plan, the plan free, not
 * for sale, or no valid yearly price in the currency.
 */
export function yearlyOffer(plan: Priced, currency: string, yearlyOn: boolean): YearlyOffer | null {
  if (!yearlyOn || !plan.yearlyEnabled || plan.id === "free" || !plan.purchasable || !plan.active) return null;
  const price = yearlyConfigured(plan, currency);
  if (typeof price !== "number" || !Number.isInteger(price) || price <= 0) return null;
  return {
    price,
    perMonth: monthlyEquivalent(price),
    discount: yearlyDiscountPercent(planPrice(plan, currency), price),
    badge: plan.yearlyBadge?.trim() || null,
  };
}

/**
 * The amount to charge for a plan, currency and cycle — the single answer
 * checkout uses. Null when that combination is not on sale.
 */
export function cyclePrice(plan: Priced, currency: string, cycle: BillingCycle, yearlyOn: boolean): number | null {
  if (cycle === "monthly") return planPrice(plan, currency);
  return yearlyOffer(plan, currency, yearlyOn)?.price ?? null;
}
