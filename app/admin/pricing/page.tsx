import Link from "next/link";

import { NoRows, Panel } from "@/components/admin/Panels";
import { PricingTable, type PricingRow } from "@/components/admin/PricingTable";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { adminStats, listAdminLogs } from "@/lib/db/admin";
import { formatDateTime } from "@/lib/format";
import { CURRENCIES, CURRENCY_META } from "@/lib/money";
import { checkoutOptionsFor } from "@/lib/payments";
import { listPlans } from "@/lib/plan-catalogue";
import { currencyReadiness } from "@/lib/currency-readiness";
import { siteCurrency } from "@/lib/site-currency";
import { yearlyBillingSetting } from "@/lib/billing/yearly-settings";
import { yearlyOffer } from "@/lib/billing/offer";
import { YearlyBillingSwitch } from "@/components/admin/YearlyBillingSwitch";

export const dynamic = "force-dynamic";

export const metadata = { title: "Pricing — Admin" };

/**
 * INR and USD prices for every plan, edited independently.
 *
 * The admin layout has already required an administrator; the API this
 * page calls checks again on every request. Prices are stored as integer
 * minor units in the plans table — INR in the original column, USD in its
 * own — and are read live by the pricing page and by checkout.
 */
export default async function AdminPricingPage() {
  const plans = listPlans();
  const stats = adminStats();
  const history = listAdminLogs({ targetType: "plan", limit: 50 })
    .filter((entry) => entry.action === "plan.price_changed")
    .slice(0, 12);

  const rows: PricingRow[] = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    inrMinor: plan.amountPaise,
    usdMinor: plan.usdAmountCents,
    yearlyInrMinor: plan.yearlyAmountPaise,
    yearlyUsdMinor: plan.yearlyUsdCents,
    yearlyEnabled: plan.yearlyEnabled,
    yearlyBadge: plan.yearlyBadge,
    interval: "Monthly",
    status: !plan.active
      ? { label: "Hidden", tone: "warn" }
      : plan.id === "free"
        ? { label: "Granted on sign-up", tone: "neutral" }
        : plan.purchasable
          ? { label: "On sale", tone: "pass" }
          : { label: "Not for sale", tone: "warn" },
    subscribers: stats.plans[plan.id] ?? 0,
    updatedAt: plan.updatedAt || null,
    // A row nobody has edited carries only its seeding time, which is not
    // an "update" anyone made.
    updatedLabel: plan.updatedBy
      ? `Updated ${formatDateTime(plan.updatedAt)} by ${plan.updatedBy}`
      : "Shipped default",
    isFree: plan.id === "free",
  }));

  const yearly = yearlyBillingSetting();
  const yearlyReady = plans.filter((plan) => yearlyOffer(plan, siteCurrency(), true) !== null).length;

  const reach = CURRENCIES.map((currency) => ({
    currency,
    gateways: checkoutOptionsFor(currency).map((option) => option.label),
    plansPriced: plans.filter(
      (plan) =>
        plan.id !== "free" &&
        plan.active &&
        plan.purchasable &&
        (currency === "INR" ? plan.amountPaise > 0 : plan.usdAmountCents !== null),
    ).length,
  }));

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Pricing"
        lede="Set each plan's monthly and yearly prices in Indian rupees and in US dollars. Each price is separate — changing one never changes another, and nothing is converted."
      />

      {(() => {
        const site = siteCurrency();
        const ready = currencyReadiness(site);
        return (
          <div
            role={ready.ready ? "status" : "alert"}
            className={`rounded-xl border px-4 py-3 text-[0.9375rem] leading-relaxed ${ready.ready ? "border-ink-700 bg-white" : "border-amber-400/30 bg-amber-400/[0.07]"}`}
          >
            <p className="font-semibold text-cloud-50">
              Customers see {site} prices ({CURRENCY_META[site].name}).{" "}
              <Link href="/admin/settings/currency" className="font-medium text-azure-600 hover:underline">
                Change the website currency
              </Link>
            </p>
            {ready.missingPrices.length ? (
              <p className="mt-0.5 text-cloud-300">
                {ready.missingPrices.map((p) => p.name).join(", ")} {ready.missingPrices.length === 1 ? "has" : "have"} no {site} price, so customers can&apos;t buy {ready.missingPrices.length === 1 ? "it" : "them"} until you set one below.
              </p>
            ) : null}
            {!ready.payableBy.length ? <p className="mt-0.5 text-cloud-300">No enabled payment gateway can take {site}, so checkout is closed.</p> : null}
          </div>
        );
      })()}

      <Panel
        title="Yearly billing"
        description="When on, the pricing page shows a Monthly / Yearly switch for plans with a yearly price below. Off returns the site to monthly-only straight away; yearly subscriptions already bought keep their twelve months."
        action={<YearlyBillingSwitch enabled={yearly.enabled} />}
      >
        <p className="text-[0.875rem] text-cloud-300">
          {yearly.enabled
            ? `On${yearly.updatedBy ? ` — turned on ${yearly.updatedAt ? formatDateTime(yearly.updatedAt) : ""} by ${yearly.updatedBy}` : ""}. ${yearlyReady} plan${yearlyReady === 1 ? " is" : "s are"} offered yearly in ${siteCurrency()}.`
            : `Off — customers see monthly prices only.${yearlyReady ? ` ${yearlyReady} plan${yearlyReady === 1 ? " has" : "s have"} a yearly price ready.` : ""}`}{" "}
          The discount is worked out as (1 − yearly ÷ (monthly × 12)) × 100, rounded down.
        </p>
      </Panel>

      <PricingTable rows={rows} />

      <p className="text-[0.875rem] leading-relaxed text-cloud-400">
        A new price applies to purchases from the moment it&apos;s saved. Subscriptions, payments and
        invoices already made keep the amount and currency they were paid in. Features and limits
        are edited on{" "}
        <Link href="/admin/plans" className="font-medium text-azure-600 hover:underline">
          Plans
        </Link>
        .
      </p>

      <Panel
        title="Where each currency can be paid"
        description="Checkout offers a currency only through gateways that are switched on and set up to take it."
      >
        <ul className="divide-y divide-ink-700">
          {reach.map((entry) => (
            <li key={entry.currency} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div>
                <p className="text-[0.9375rem] font-semibold text-cloud-50">
                  {entry.currency} · {CURRENCY_META[entry.currency].name}
                </p>
                <p className="mt-0.5 text-[0.875rem] text-cloud-300">
                  {entry.gateways.length > 0
                    ? `Paid through ${entry.gateways.join(", ")}.`
                    : "No enabled gateway can take it yet."}{" "}
                  {entry.plansPriced} paid {entry.plansPriced === 1 ? "plan has" : "plans have"} a price.
                </p>
              </div>
              <Badge tone={entry.gateways.length > 0 && entry.plansPriced > 0 ? "pass" : "warn"}>
                {entry.gateways.length > 0 && entry.plansPriced > 0 ? "Available at checkout" : "Not available"}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-ink-700 pt-3 text-[0.875rem] text-cloud-400">
          Which gateway takes which currency is set on{" "}
          <Link href="/admin/payment-gateways" className="font-medium text-azure-600 hover:underline">
            Payment gateways
          </Link>
          .
        </p>
      </Panel>

      <Panel title="Recent price changes" description="From the audit log.">
        {history.length === 0 ? (
          <NoRows>No price has been changed yet.</NoRows>
        ) : (
          <ul className="divide-y divide-ink-700">
            {history.map((entry) => (
              <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
                <p className="text-[0.9375rem] text-cloud-50">
                  <span className="font-semibold">{entry.targetLabel ?? entry.targetId}</span> — {entry.detail}
                </p>
                <p className="mt-0.5 text-[0.8125rem] text-cloud-400">
                  {formatDateTime(entry.createdAt)} · {entry.adminEmail}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
