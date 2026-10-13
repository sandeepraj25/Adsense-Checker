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

/**
 * Where a plan's call to action leads for a visitor who isn't signed in:
 * sign-up, carrying the plan (and currency and domain) in a trusted return
 * path. A paid plan lands on its checkout page afterwards — nothing is
 * charged until the person pays there; Free lands back on /pricing.
 *
 * Shared by /pricing and the homepage pricing section so both send a
 * visitor down exactly the same flow.
 */
export function planSignupHref(input: {
  planId: string;
  plans: PlanRecord[];
  carryUrl?: string;
}): string {
  const { planId, plans, carryUrl } = input;
  const nextParams = new URLSearchParams({ plan: planId });
  const paid = plans.some((p) => p.id === planId && p.purchasable && p.amountPaise > 0);
  if (carryUrl) nextParams.set("url", carryUrl);
  const next = `${paid ? "/checkout" : "/pricing"}?${nextParams.toString()}`;

  const params = new URLSearchParams({
    next,
    plan: planId,
  });

  if (carryUrl) {
    params.set("url", carryUrl);
  }

  return `/signup?${params.toString()}`;
}

/**
 * The plan cards and their calls to action, rendered from the live plan
 * catalogue — names, prices, currencies and features all come from the
 * database, never from this file. Moved here unchanged from the pricing
 * page so the homepage can show the same cards with the same buttons.
 */
export function PlanGrid({
  plans,
  user,
  subscription,
  currency,
  options,
  carryUrl,
  selectedPlanId,
}: {
  plans: PlanRecord[];
  user: User | null;
  subscription: Subscription | null;
  currency: Currency;
  /** Enabled gateways that take `currency`. */
  options: CheckoutOption[];
  carryUrl?: string;
  selectedPlanId: PlanId | null;
}) {
  const signupHref = (planId: string) => planSignupHref({ planId, plans, carryUrl });
  const methodNames = options.map((option) => option.label);

  return (
    <>
    {/* One column until three cards genuinely fit side by side.
        The old md:2 / xl:3 split left Pro orphaned on its own row
        at tablet widths and stretched each card across the page. */}
    <div className="mx-auto grid max-w-lg grid-cols-1 gap-5 lg:max-w-6xl lg:grid-cols-3">
      {plans.map((plan, index) => {
        const isCurrent = subscription?.planId === plan.id;
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
          PLAN_RANK[plan.id] > currentRank
            ? "Upgrade to"
            : "Switch to";

        let cta: React.ReactNode;

        if (!plan.purchasable) {
          cta = user ? (
            <p className="text-center text-[0.875rem] text-cloud-50">
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
            <p className="text-center text-[0.875rem] leading-snug text-cloud-300">
              Not available to buy right now.
            </p>
          );
        } else if (isCurrent) {
          cta = (
            <p className="text-center text-[0.875rem] leading-snug text-cloud-50">
              Your current plan, active until{" "}
              {formatDate(subscription?.expiresAt ?? Date.now())}.
            </p>
          );
        } else if (!user) {
          cta = (
            <ButtonLink
              href={signupHref(plan.id)}
              variant={plan.featured ? "primary" : "ghost"}
              size="md"
            >
              Get {plan.name}
            </ButtonLink>
          );
        } else {
          cta = (
            <CheckoutButton
              planId={plan.id}
              planName={plan.name}
              label={`${verb} ${plan.name}`}
              options={options}
              carryUrl={carryUrl}
              currency={currency}
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
              className={
                plan.id === selectedPlanId
                  ? "h-full ring-2 ring-azure-500/30"
                  : "h-full"
              }
              {...(inherits ? { inherits } : {})}
              cta={cta}
            />
          </Reveal>
        );
      })}
    </div>

    <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[0.875rem] text-cloud-50">
      <span className="inline-flex items-center gap-2">
        <ShieldCheck className="size-4" aria-hidden />

        {methodNames.length > 0
          ? `Payments handled by ${methodNames.join(", ")}`
          : "Online payment is available"}
      </span>

      <span>
        Prices in {CURRENCY_META[currency].name} per month, inclusive of applicable taxes
      </span>

      <span>Invoice issued for every payment</span>
    </div>
    </>
  );
}
