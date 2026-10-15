
import { ShieldCheck } from "lucide-react";

import { CheckoutButton } from "@/components/pricing/CheckoutButton";
import { PlanCard } from "@/components/pricing/PlanCard";
import { ButtonLink } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";
import type { Subscription, User } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { CURRENCY_META, type Currency } from "@/lib/money";
import type { CheckoutOption } from "@/lib/payments";
import type { PlanRecord } from "@/lib/plan-catalogue";
import { PLAN_RANK, planPrice, type PlanId } from "@/lib/plans";
import type { BillingCycle } from "@/lib/billing/cycle";
import { yearlyOffer } from "@/lib/billing/offer";

export function planSignupHref(input: {
  planId: string;
  plans: PlanRecord[];
  carryUrl?: string;
  cycle?: BillingCycle;
}): string {
  const { planId, plans, carryUrl } = input;
  const nextParams = new URLSearchParams({ plan: planId });
  const paid = plans.some(
    (p) => p.id === planId && p.purchasable && p.amountPaise > 0,
  );

  if (carryUrl) nextParams.set("url", carryUrl);
  if (paid && input.cycle === "yearly") {
    nextParams.set("cycle", "yearly");
  }

  const next = `${paid ? "/checkout" : "/pricing"}?${nextParams.toString()}`;
  const params = new URLSearchParams({ next, plan: planId });

  if (carryUrl) params.set("url", carryUrl);

  return `/signup?${params.toString()}`;
}

export function PlanGrid({
  plans,
  user,
  subscription,
  currency,
  options,
  carryUrl,
  selectedPlanId,
  cycle = "monthly",
  yearlyOn = false,
}: {
  plans: PlanRecord[];
  user: User | null;
  subscription: Subscription | null;
  currency: Currency;
  options: CheckoutOption[];
  carryUrl?: string;
  selectedPlanId: PlanId | null;
  cycle?: BillingCycle;
  yearlyOn?: boolean;
}) {
  const signupHref = (
    planId: string,
    planCycle: BillingCycle = "monthly",
  ) => planSignupHref({ planId, plans, carryUrl, cycle: planCycle });

  const methodNames = options.map((option) => option.label);

  return (
    <>
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-stretch gap-5 sm:gap-6 lg:grid-cols-3 lg:gap-7">
        {plans.map((plan, index) => {
          const isCurrent = subscription?.planId === plan.id;

          const offer =
            cycle === "yearly" ? yearlyOffer(plan, currency, yearlyOn) : null;

          const planCycle: BillingCycle = offer ? "yearly" : "monthly";
          const previous = index > 0 ? plans[index - 1] : null;

          const inherits =
            previous &&
              previous.features.length > 0 &&
              previous.features.every((feature) =>
                plan.features.includes(feature),
              ) &&
              plan.showcase.length < plan.features.length
              ? previous.name
              : undefined;

          const currentRank = subscription
            ? PLAN_RANK[subscription.planId]
            : 0;

          const verb =
            PLAN_RANK[plan.id] > currentRank ? "Upgrade to" : "Switch to";

          let cta: React.ReactNode;

          if (!plan.purchasable) {
            cta = user ? (
              <p className="text-center text-sm text-slate-500">
                {isCurrent
                  ? "Active on your account"
                  : "Included when you sign up"}
              </p>
            ) : (
              <ButtonLink
                href={signupHref(plan.id)}
                variant="ghost"
                size="md"
              >
                Start free
              </ButtonLink>
            );
          } else if (planPrice(plan, currency) === null) {
            cta = (
              <p className="text-center text-sm leading-snug text-slate-500">
                Not available to buy right now.
              </p>
            );
          } else if (isCurrent) {
            cta = (
              <p className="text-center text-sm leading-snug text-slate-500">
                Your current plan, active until{" "}
                {subscription?.expiresAt
                  ? formatDate(subscription.expiresAt)
                  : "your renewal date"}.
              </p>
            );
          } else if (!user) {
            cta = (
              <ButtonLink
                href={signupHref(plan.id, planCycle)}
                variant={plan.featured ? "primary" : "ghost"}
                size="md"
              >
                Get {plan.name}
                {planCycle === "yearly" ? " yearly" : ""}
              </ButtonLink>
            );
          } else {
            cta = (
              <CheckoutButton
                planId={plan.id}
                planName={plan.name}
                label={`${verb} ${plan.name}${planCycle === "yearly" ? " yearly" : ""}`}
                options={options}
                carryUrl={carryUrl}
                currency={currency}
                cycle={planCycle}
                variant={plan.featured ? "primary" : "ghost"}
              />
            );
          }

          return (
            <Reveal key={plan.id} delay={index * 0.06}>
              <PlanCard
                plan={plan}
                currency={currency}
                current={isCurrent}
                cycle={cycle}
                yearly={offer}
                className={
                  plan.id === selectedPlanId
                    ? "h-full ring-2 ring-blue-500/30"
                    : "h-full"
                }
                {...(inherits ? { inherits } : {})}
                cta={cta}
              />
            </Reveal>
          );
        })}
      </div>

      <div className="mx-auto mt-8 flex max-w-5xl flex-wrap items-center justify-center gap-x-6 gap-y-3 text-center text-sm text-slate-500">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-blue-600" aria-hidden />

          {methodNames.length > 0
            ? `Payments handled by ${methodNames.join(", ")}`
            : "Online payment is available"}
        </span>

        <span>
          {cycle === "yearly"
            ? `Prices in ${CURRENCY_META[currency].name}, inclusive of applicable taxes. Yearly plans are paid once for 12 months; scans still reset every month`
            : `Prices in ${CURRENCY_META[currency].name} per month, inclusive of applicable taxes`}
        </span>

        <span>Invoice issued for every payment</span>
      </div>
    </>
  );
}
