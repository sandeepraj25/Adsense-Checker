import Link from "next/link";

import { NoRows, Panel } from "@/components/admin/Panels";
import { PlanEditor, type EditablePlan } from "@/components/admin/PlanEditor";
import { PageHeading, StatTile } from "@/components/dashboard/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { adminStats, listAdminLogs } from "@/lib/db/admin";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { ALL_FEATURES, listPlans } from "@/lib/plan-catalogue";
import { FEATURE_META, PLANS } from "@/lib/plans";

export const dynamic = "force-dynamic";

export const metadata = { title: "Plans — Admin" };

/**
 * Plan and pricing configuration.
 *
 * These three rows are the single source of truth for what anything costs
 * and what anything allows: the pricing page renders them, checkout charges
 * them, and every entitlement check reads them. Nothing in the codebase
 * hardcodes ₹399.
 *
 * The consequence is stated on the page rather than hidden: editing a plan
 * changes what the *next* purchase costs and allows. Subscriptions already
 * sold keep the price, limits and features they were sold with, because
 * rewriting them would contradict invoices customers already hold.
 */
export default async function AdminPlansPage() {
  const plans = listPlans();
  const stats = adminStats();
  const history = listAdminLogs({ targetType: "plan", limit: 20 });

  const featureMeta = ALL_FEATURES.map((key) => ({
    key,
    label: FEATURE_META[key].label,
    does: FEATURE_META[key].does,
    // The shipped tier, not the current one — it is context for the
    // operator ("this was designed as a Pro feature"), not a constraint.
    minPlan: PLANS[FEATURE_META[key].minPlan].name,
  }));

  const editable: EditablePlan[] = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    priceLabel:
      plan.id === "free"
        ? "Free"
        : `${formatMoney(plan.amountPaise, "INR")} · ${
            plan.usdAmountCents === null ? "not offered in USD" : formatMoney(plan.usdAmountCents, "USD")
          }`,
    siteLimit: plan.siteLimit,
    scanLimit: plan.scanLimit,
    pagesPerScan: plan.pagesPerScan,
    active: plan.active,
    purchasable: plan.purchasable,
    featured: plan.featured,
    features: [...plan.features],
    showcase: [...plan.showcase],
    highlights: [...plan.highlights],
    subscribers: stats.plans[plan.id],
    updatedAt: plan.updatedAt,
    updatedBy: plan.updatedBy,
  }));

  const sellable = plans.filter((plan) => plan.active && plan.purchasable);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Plans"
        lede="Three monthly plans. Every limit and feature below is read live by the pricing page, by checkout and by the analysis engine. Prices are set on the Pricing page."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {plans.map((plan) => (
          <StatTile
            key={plan.id}
            label={plan.name}
            value={plan.amountPaise === 0 ? "Free" : formatMoney(plan.amountPaise, "INR")}
            tone={plan.active ? "default" : "warn"}
            hint={
              plan.active
                ? `${stats.plans[plan.id]} on this plan`
                : "Hidden from pricing"
            }
          />
        ))}
        <StatTile
          label="Sellable"
          value={sellable.length}
          tone={sellable.length === 0 ? "fail" : "default"}
          hint={
            sellable.length === 0
              ? "Nothing can be bought"
              : sellable.map((plan) => plan.name).join(", ")
          }
        />
      </div>

      <Panel title="What editing a plan does">
        <ul className="grid gap-2 text-[0.8125rem] leading-snug text-cloud-400 sm:grid-cols-2">
          <li>
            <span className="text-cloud-200">Price</span> — applies to the next
            purchase and the next renewal. A running subscription keeps the
            amount it was sold at, so invoices already issued stay true.
          </li>
          <li>
            <span className="text-cloud-200">Limits</span> — apply to new
            subscriptions on this plan. To change a limit for one customer, edit
            their subscription on{" "}
            <Link href="/admin/users" className="text-azure-600 hover:text-azure-600">
              their account
            </Link>
            .
          </li>
          <li>
            <span className="text-cloud-200">Features</span> — enforced, not
            decorative. Turning one off stops the engine running that analysis
            and locks the section in new reports.
          </li>
          <li>
            <span className="text-cloud-200">Offered / sold</span> — an inactive
            plan disappears from the pricing page; an unsold plan is visible but
            has no checkout button.
          </li>
        </ul>
      </Panel>

      {editable.map((plan) => (
        <PlanEditor key={plan.id} plan={plan} featureMeta={featureMeta} />
      ))}

      <Panel
        title="Pricing change history"
        description="Every plan edit, with the administrator who made it. Price changes are recorded under their own action so they are easy to find later."
      >
        {history.length === 0 ? (
          <NoRows>No plan has been edited. All three are at their shipped defaults.</NoRows>
        ) : (
          <ul className="divide-y divide-ink-850">
            {history.map((entry) => (
              <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="flex items-center gap-2 text-[0.8125rem]">
                    <span className="t-data text-cloud-200">{entry.action}</span>
                    {entry.action === "plan.price_changed" ? (
                      <Badge tone="warn">Price</Badge>
                    ) : null}
                    <span className="text-cloud-600">{entry.targetLabel}</span>
                  </p>
                  <p className="t-data text-[0.75rem] text-cloud-600">
                    {formatDateTime(entry.createdAt)}
                  </p>
                </div>
                <p className="mt-1 text-[0.8125rem] leading-snug text-cloud-400">
                  {entry.detail ?? "—"}
                </p>
                <p className="mt-0.5 text-[0.75rem] text-cloud-600">
                  by {entry.adminEmail}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
