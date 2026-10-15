import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { checkoutHref } from "@/components/pricing/CheckoutButton";
import { cn } from "@/lib/cn";
import type { Subscription } from "@/lib/db/types";
import { formatMoney, type Currency } from "@/lib/money";
import type { CheckoutOption } from "@/lib/payments";
import type { PlanRecord } from "@/lib/plan-catalogue";
import { FEATURE_META, PLAN_RANK, planPrice } from "@/lib/plans";
import type { BillingCycle } from "@/lib/billing/cycle";
import { yearlyOffer } from "@/lib/billing/offer";

/**
 * The plan row at the top of Billing. Every value comes from the live
 * plan catalogue in the website currency, and every button follows the
 * same rules as the signed-in pricing page: the current plan can't be
 * bought again, a plan with no price or no payment method says so, and
 * any other plan links to the existing checkout page.
 */
export function BillingPlanCards({
  plans,
  current,
  currency,
  options,
  cycle = "monthly",
  yearlyOn = false,
  renewal = null,
}: {
  plans: PlanRecord[];
  current: Subscription | null;
  currency: Currency;
  /** Enabled gateways that can take `currency`. */
  options: CheckoutOption[];
  /** Which prices to show; plans with no yearly offer stay monthly. */
  cycle?: BillingCycle;
  yearlyOn?: boolean;
  /** The plan whose period ended, offered as "Renew" rather than "Switch". */
  renewal?: { planId: string } | null;
}) {
  const currentRank = current ? PLAN_RANK[current.planId] : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {plans.map((plan) => {
        const dark = plan.featured;
        const isCurrent = current?.planId === plan.id && !current.isExpired;
        const offer = cycle === "yearly" ? yearlyOffer(plan, currency, yearlyOn) : null;
        const planCycle: BillingCycle = offer ? "yearly" : "monthly";
        const price = offer ? offer.price : planPrice(plan, currency);
        const lines = [
          `${plan.scanLimit} scans per month`,
          `${plan.siteLimit} ${plan.siteLimit === 1 ? "website" : "websites"}`,
          ...plan.showcase.map((feature) => FEATURE_META[feature].label),
        ].slice(0, 6);

        const buttonBase =
          "inline-flex h-10 w-full items-center justify-center rounded-lg px-4 text-[0.875rem] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500";

        let action: React.ReactNode;
        if (isCurrent) {
          action = (
            <span aria-disabled className={cn(buttonBase, dark ? "bg-white/15 text-white" : "bg-ink-850 text-cloud-200")}>
              Current Plan
            </span>
          );
        } else if (!plan.purchasable) {
          action = (
            <span className={cn(buttonBase, dark ? "bg-white/10 text-white/80" : "border border-ink-700 text-cloud-300")}>
              Included with every account
            </span>
          );
        } else if (price === null) {
          action = (
            <span className={cn(buttonBase, dark ? "bg-white/10 text-white/80" : "border border-ink-700 text-cloud-300")}>
              Not available right now
            </span>
          );
        } else if (options.length === 0) {
          action = (
            <span className={cn(buttonBase, dark ? "bg-white/10 text-white/80" : "border border-ink-700 text-cloud-300")}>
              Purchase unavailable
            </span>
          );
        } else {
          action = (
            <Link
              href={checkoutHref(plan.id, undefined, planCycle)}
              className={cn(buttonBase, dark ? "bg-white text-zinc-900 hover:bg-zinc-100" : "bg-zinc-900 text-white hover:bg-zinc-800")}
            >
              {renewal?.planId === plan.id
                ? `Renew ${planCycle === "yearly" ? "yearly" : "monthly"}`
                : PLAN_RANK[plan.id] > currentRank
                  ? "Upgrade Plan"
                  : `Switch to ${plan.name}`}
            </Link>
          );
        }

        return (
          <article
            key={plan.id}
            className={cn(
              "relative flex flex-col rounded-2xl border p-5 sm:p-6",
              dark
                ? "border-zinc-800 bg-[radial-gradient(120%_80%_at_50%_0%,#3f3f46_0%,#18181b_45%,#09090b_100%)] text-white shadow-[0_18px_40px_-20px_rgba(9,9,11,0.6)]"
                : "border-ink-700 bg-white shadow-[0_1px_2px_rgba(24,24,27,0.04)]",
              isCurrent && !dark && "ring-1 ring-azure-500/25",
            )}
          >
            {/* Corner rivets, as in the reference design. */}
            {["left-3 top-3", "right-3 top-3", "left-3 bottom-3", "right-3 bottom-3"].map((pos) => (
              <span key={pos} aria-hidden className={cn("absolute size-1.5 rounded-full", pos, dark ? "bg-white/20" : "bg-ink-700")} />
            ))}

            <div className="flex items-center justify-between gap-3">
              <h3 className={cn("text-[1rem] font-semibold", dark ? "text-white" : "text-cloud-50")}>{plan.name} Plan</h3>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.6875rem] font-semibold tracking-wide",
                  dark ? "bg-orange-500 text-white" : "border border-ink-700 bg-white text-cloud-200",
                )}
              >
                <span aria-hidden className={cn("size-1.5 rounded-full", dark ? "bg-white" : plan.id === "free" ? "bg-orange-500" : "bg-emerald-500")} />
                {isCurrent ? "CURRENT" : plan.id.toUpperCase()}
              </span>
            </div>

            <p className="mt-4 flex items-baseline gap-1.5">
              {price === null ? (
                <span className={cn("text-[1.25rem] font-semibold", dark ? "text-white/80" : "text-cloud-300")}>Not available</span>
              ) : (
                <>
                  <span className={cn("t-data text-[2rem] font-bold leading-none tracking-tight", dark ? "text-white" : "text-cloud-50")}>
                    {formatMoney(price, currency)}
                  </span>
                  <span className={cn("text-[0.875rem]", dark ? "text-white/60" : "text-cloud-400")}>{offer ? "/year" : "/month"}</span>
                </>
              )}
            </p>
            {cycle === "yearly" && plan.id !== "free" && price !== null ? (
              <p className={cn("mt-1.5 text-[0.8125rem]", dark ? "text-white/70" : "text-cloud-400")}>
                {offer
                  ? `≈ ${formatMoney(offer.perMonth, currency)}/month${offer.discount ? ` · save ${offer.discount}%` : ""}${offer.badge ? ` · ${offer.badge}` : ""}`
                  : "Billed monthly — no yearly option"}
              </p>
            ) : null}

            <div className="mt-5">{action}</div>

            <ul className={cn("mt-6 space-y-2.5 border-t pt-5", dark ? "border-white/10" : "border-ink-700")}>
              {lines.map((line) => (
                <li key={line} className={cn("flex items-start gap-2.5 text-[0.8125rem] leading-snug", dark ? "text-white/80" : "text-cloud-300")}>
                  <CheckCircle2 aria-hidden className={cn("mt-px size-4 shrink-0", dark ? "text-white/60" : "text-cloud-400")} />
                  {line}
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
