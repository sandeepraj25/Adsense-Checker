import { gatewayLabel, gatewayViews, checkoutOptionsFor } from "@/lib/payments";
import type { Currency } from "@/lib/money";
import { listActivePlans } from "@/lib/plan-catalogue";
import { planPrice } from "@/lib/plans";

/**
 * Whether the site can actually sell in a currency right now: which paid
 * plans have a price in it, and which enabled gateways can take it as
 * configured. Shown to administrators before and after a currency change,
 * so a switch that would block checkout is visible, not discovered by a
 * customer.
 */
export type CurrencyReadiness = {
  currency: Currency;
  /** Paid, purchasable plans with no price in this currency. */
  missingPrices: { id: string; name: string }[];
  /** Plans and their price in this currency (null = not set). */
  prices: { id: string; name: string; amount: number | null }[];
  /** Enabled gateways that can take this currency at checkout. */
  payableBy: string[];
  /** Every gateway, with whether it can take this currency and why. */
  gateways: { id: string; label: string; enabled: boolean; available: boolean; reason: string }[];
  ready: boolean;
};

export function currencyReadiness(currency: Currency): CurrencyReadiness {
  const plans = listActivePlans();
  const paid = plans.filter((plan) => plan.purchasable && plan.amountPaise > 0);
  const missingPrices = paid.filter((plan) => {
    const amount = planPrice(plan, currency);
    return amount === null || amount <= 0;
  });
  const payableBy = [...new Set(checkoutOptionsFor(currency).map((option) => option.label))];
  const gateways = gatewayViews().map((view) => ({
    id: view.id,
    label: gatewayLabel(view.id),
    enabled: view.enabled,
    available: view.currencies[currency].available,
    reason: view.currencies[currency].reason,
  }));
  return {
    currency,
    missingPrices: missingPrices.map((plan) => ({ id: plan.id, name: plan.name })),
    prices: plans.map((plan) => ({ id: plan.id, name: plan.name, amount: planPrice(plan, currency) })),
    payableBy,
    gateways,
    ready: missingPrices.length === 0 && payableBy.length > 0,
  };
}
