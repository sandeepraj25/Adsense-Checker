import { CycleSwitcher } from "@/components/pricing/CycleSwitcher";
import { PlanGrid } from "@/components/pricing/PlanGrid";
import type { BillingCycle } from "@/lib/billing/cycle";
import { yearlyOffer } from "@/lib/billing/offer";
import { yearlyBillingEnabled } from "@/lib/billing/yearly-settings";

/**
 * The plan cards with the Monthly / Yearly switch above them. The switch
 * appears only when yearly billing is on and at least one plan has a valid
 * yearly price in the site currency; otherwise this is exactly the
 * monthly grid it always was.
 */
export function PricingPlans(props: Omit<React.ComponentProps<typeof PlanGrid>, "cycle" | "yearlyOn"> & { initialCycle?: BillingCycle }) {
  const { initialCycle, ...grid } = props;
  const yearlyOn = yearlyBillingEnabled();
  const offers = props.plans.map((plan) => yearlyOffer(plan, props.currency, yearlyOn)).filter((o) => o !== null);
  if (offers.length === 0) return <PlanGrid {...grid} />;
  const discounts = offers.map((o) => o.discount ?? 0);
  const best = Math.max(...discounts);
  return (
    <CycleSwitcher
      initial={initialCycle === "yearly" ? "yearly" : "monthly"}
      bestDiscount={best > 0 ? best : null}
      monthly={<PlanGrid {...grid} cycle="monthly" yearlyOn={yearlyOn} />}
      yearly={<PlanGrid {...grid} cycle="yearly" yearlyOn={yearlyOn} />}
    />
  );
}
