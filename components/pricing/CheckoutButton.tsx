import { ArrowRight, Lock } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { CheckoutOption } from "@/lib/payments";
import type { Currency } from "@/lib/money";
import type { PlanId } from "@/lib/plans";

/**
 * The paid-plan call to action on the pricing page.
 *
 * It used to open the gateway in place. Purchases now go through the
 * dedicated checkout page (/checkout?plan=…), which collects billing
 * details first; the gateway handoff itself moved, unchanged, to
 * lib/checkout-client.ts. The props are kept so the pricing page did not
 * have to change shape.
 */
export function checkoutHref(planId: PlanId, carryUrl?: string): string {
  // The checkout page charges in the site currency an administrator set,
  // so the link carries only the plan (and the domain to scan afterwards).
  const params = new URLSearchParams({ plan: planId });
  if (carryUrl) params.set("url", carryUrl);
  return `/checkout?${params.toString()}`;
}

export function CheckoutButton({
  planId,
  label,
  options,
  carryUrl,
  currency = "INR",
  variant = "primary",
  className,
}: {
  planId: PlanId;
  planName: string;
  label: string;
  /** Enabled gateways that take `currency`, resolved on the server. Empty means checkout is shut for it. */
  options: CheckoutOption[];
  /** The site currency, for the unavailable message. */
  currency?: Currency;
  /** Domain the visitor was trying to audit, carried through the purchase. */
  carryUrl?: string;
  variant?: "primary" | "ghost";
  className?: string;
}) {
  // Nothing enabled: no working-looking button that leads nowhere.
  if (options.length === 0) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <Button variant="primary" size="md" disabled>
          <Lock className="size-3.5 opacity-70" aria-hidden />
          Purchase unavailable
        </Button>
        <p className="text-center text-[0.8125rem] leading-snug text-cloud-400">
          {`Online payment in ${currency} is temporarily unavailable. Please try again later.`}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <ButtonLink href={checkoutHref(planId, carryUrl)} variant={variant} size="md">
        {label}
        {variant === "primary" ? (
          <ArrowRight className="size-4" aria-hidden />
        ) : (
          <Lock className="size-3.5 opacity-70" aria-hidden />
        )}
      </ButtonLink>
      <p className="text-center text-[0.8125rem] text-cloud-400">
        {options.map((option) => option.label).join(" · ")}
      </p>
    </div>
  );
}
