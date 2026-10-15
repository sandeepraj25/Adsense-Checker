import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Check, LockKeyhole } from "lucide-react";
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from "libphonenumber-js/max";

import { CheckoutForm, type CountryOption } from "@/components/checkout/CheckoutForm";
import { ToastProvider } from "@/components/ui/Toast";
import { ButtonLink } from "@/components/ui/Button";
import { checkCountFor } from "@/lib/analysis/checks";
import { requireUser } from "@/lib/auth/guard";
import { DEFAULT_BILLING_COUNTRY } from "@/lib/billing-details";
import {
  expireStaleSubscriptions,
  getActiveSubscription,
  latestBillingDetails,
} from "@/lib/db/billing";
import { normalizeDomain } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import { CURRENCY_META, formatMoney, type Currency } from "@/lib/money";
import { siteCurrency } from "@/lib/site-currency";
import { checkoutOptionsFor } from "@/lib/payments";
import { getPlan } from "@/lib/plan-catalogue";
import { FEATURE_META, planPrice } from "@/lib/plans";
import { cycleLabel, type BillingCycle } from "@/lib/billing/cycle";
import { yearlyOffer } from "@/lib/billing/offer";
import { yearlyBillingEnabled } from "@/lib/billing/yearly-settings";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Every country libphonenumber knows, named in English, India first. */
function countryOptions(): CountryOption[] {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const list = getCountries().map((code) => ({
    code,
    name: names.of(code) ?? code,
    dial: `+${getCountryCallingCode(code)}`,
  }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  const first = list.findIndex((entry) => entry.code === DEFAULT_BILLING_COUNTRY);
  if (first > 0) list.unshift(...list.splice(first, 1));
  return list;
}

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; url?: string; cycle?: string }>;
}) {
  const { plan: planParam, url, cycle: cycleParam } = await searchParams;
  // Monthly unless the link asks for yearly; the price for it is read below.
  const cycle: BillingCycle = cycleParam === "yearly" ? "yearly" : "monthly";
  // middleware.ts already sent anonymous visitors to log in with this exact
  // URL as `next`; this is the authoritative check.
  const user = await requireUser();

  // The plan — name, price, interval, limits — comes from the live
  // catalogue on the server. The query string only says which one.
  const plan = getPlan(planParam);
  const carryUrl = normalizeDomain(url ?? "") ?? undefined;

  // The currency is the site's, chosen by an administrator. A `currency`
  // left in an old link is ignored; customers can't pick another one.
  const currency: Currency = siteCurrency();

  if (!plan || !plan.active || !plan.purchasable || plan.amountPaise <= 0) {
    return (
      <Shell>
        <Notice
          title="That plan isn't available"
          body="The plan in this link doesn't exist or can't be bought right now. Choose one of the current plans to continue."
          action={{ href: "/pricing", label: "See plans" }}
        />
      </Shell>
    );
  }

  const yearlyOn = yearlyBillingEnabled();
  const offer = yearlyOffer(plan, currency, yearlyOn);
  if (cycle === "yearly" && !offer) {
    const params = new URLSearchParams({ plan: plan.id });
    if (carryUrl) params.set("url", carryUrl);
    return (
      <Shell>
        <Notice
          title={`${plan.name} isn't offered yearly right now`}
          body={`Yearly billing isn't available for the ${plan.name} plan at the moment. Nothing has been charged — you can buy it monthly instead.`}
          action={{ href: `/checkout?${params.toString()}`, label: "Continue with monthly" }}
        />
      </Shell>
    );
  }
  const amount = cycle === "yearly" ? offer!.price : planPrice(plan, currency);

  if (amount === null) {
    return (
      <Shell>
        <Notice
          title={`${plan.name} can't be bought right now`}
          body={`The ${plan.name} plan doesn't have a price set up yet, so it can't be bought at the moment. Nothing has been charged — please check back soon or contact support.`}
          action={{ href: "/pricing", label: "See plans" }}
        />
      </Shell>
    );
  }

  expireStaleSubscriptions();
  const current = getActiveSubscription(user.id);
  if (current && current.planId === plan.id) {
    // Paying again would replace the period already paid for, so a change
    // of cycle on the same plan is scheduled for renewal instead.
    const switching = cycle !== current.billingCycle;
    return (
      <Shell>
        <Notice
          title={`${plan.name} is already your plan`}
          body={
            switching
              ? `Your ${plan.name} plan is paid ${current.billingCycle === "yearly" ? "yearly" : "monthly"} until ${formatDate(current.expiresAt)}. To move to ${cycle} billing, schedule it on your billing page — it applies when you renew, and nothing is charged now.`
              : `Your ${plan.name} plan is active until ${formatDate(current.expiresAt)}. There's nothing to pay for now.`
          }
          action={{ href: "/dashboard/billing", label: "Go to billing" }}
        />
      </Shell>
    );
  }

  // Only gateways set up to take this currency. If none can, the form
  // says so and offers the other currency rather than charging in it.
  const options = checkoutOptionsFor(currency);
  const previous = latestBillingDetails(user.id);
  const previousPhone = previous ? parsePhoneNumberFromString(previous.phone) : undefined;

  const prefill = {
    name: previous?.name ?? "",
    email: previous?.email ?? user.email,
    country: previousPhone?.country ?? previous?.country ?? DEFAULT_BILLING_COUNTRY,
    // The national number without the trunk prefix (no leading 0 in India).
    phone: previousPhone?.nationalNumber ?? "",
  };

  const checks = checkCountFor(plan.features);
  const price = formatMoney(amount, currency);
  const intervalLabel = cycleLabel(cycle);
  const accessLabel = cycle === "yearly" ? "12 months of access" : "1 month of access";

  const summary = (
    <section
      key="order-summary"
      aria-labelledby="summary-heading"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >

      <h2 id="summary-heading" className="text-[1.0625rem] font-semibold text-cloud-50">
        Order summary
      </h2>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[1.125rem] font-semibold text-cloud-50">{plan.name} plan</p>
          <p className="mt-0.5 text-[0.875rem] text-cloud-400">
            {intervalLabel} · {accessLabel}
          </p>
          {cycle === "yearly" && offer ? (
            <p className="mt-1 text-[0.8125rem] text-cloud-300">
              ≈ {formatMoney(offer.perMonth, currency)} per month
              {offer.discount ? ` · save ${offer.discount}% vs monthly` : ""}
              {offer.badge ? ` · ${offer.badge}` : ""}
            </p>
          ) : null}
        </div>
        <p className="shrink-0 text-[1.125rem] font-semibold tabular-nums text-cloud-50">{price}</p>
      </div>

      <ul className="mt-4 space-y-2 border-t border-ink-700 pt-4 text-[0.875rem] text-cloud-200">
        <li className="flex gap-2.5">
          <Check className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden />
          {plan.scanLimit} scans per month
        </li>
        <li className="flex gap-2.5">
          <Check className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden />
          {plan.siteLimit} {plan.siteLimit === 1 ? "website" : "websites"}
        </li>
        <li className="flex gap-2.5">
          <Check className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden />
          {checks} checks per scan
        </li>
        {plan.showcase.map((feature) => (
          <li key={feature} className="flex gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden />
            {FEATURE_META[feature].label}
          </li>
        ))}
      </ul>

      <dl className="mt-4 space-y-2 border-t border-ink-700 pt-4 text-[0.9375rem]">
        <div className="flex justify-between gap-4">
          <dt className="text-cloud-400">Currency</dt>
          <dd className="text-cloud-50">
            {currency} · {CURRENCY_META[currency].name}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-cloud-400">Subtotal</dt>
          <dd className="tabular-nums text-cloud-50">{price}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-cloud-400">Taxes</dt>
          <dd className="text-cloud-300">Included in price</dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-ink-700 pt-3">
          <dt className="font-semibold text-cloud-50">Total: </dt>
          <dd className="text-[1.25rem] font-semibold tabular-nums text-cloud-50">{price}</dd>
        </div>
      </dl>

      

    </section>
  );

  return (
    <Shell>
      <div className="max-w-2xl">
        <h1 className="text-[1.75rem] font-bold leading-tight tracking-[-0.02em] text-cloud-50 sm:text-[2rem]">
          Complete your purchase
        </h1>
        <p className="mt-2 text-[0.9375rem] text-cloud-400">
          {current
            ? `You're switching from ${current.planName} to ${plan.name}${cycle === "yearly" ? ", billed yearly" : ""}.`
            : `You're buying the ${plan.name} plan${cycle === "yearly" ? ", billed yearly" : ""}.`}
        </p>
      </div>

      <CheckoutForm
        plan={{ id: plan.id, name: plan.name, priceLabel: price, currency, amountMinor: amount, billingCycle: cycle }}
        options={options}
        countries={countryOptions()}
        prefill={prefill}
        accountEmail={user.email}
        carryUrl={carryUrl}
        summary={summary}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-ink-900">
        <header className="border-b border-ink-700 bg-white">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-8">
            <Link href="/" aria-label="Home" className="shrink-0">
              <Image
                src="/logo.png"
                alt="AdSense Checker"
                width={2078}
                height={757}
                sizes="110px"
                className="h-10 w-auto"
                priority
              />
            </Link>
            <div className="flex items-center gap-4 text-[0.875rem]">
              <span className="hidden items-center gap-1.5 text-cloud-300 sm:inline-flex">
                <LockKeyhole className="size-4 text-mint-400" aria-hidden />
                Secure checkout
              </span>
              <Link
                href="/pricing"
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-cloud-200 hover:bg-ink-800 hover:text-cloud-50"
              >
                <ArrowLeft className="size-4" aria-hidden />
                Back to plans
              </Link>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-10">{children}</main>
      </div>
    </ToastProvider>
  );
}

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: { href: string; label: string };
}) {
  return (
    <div role="status" className="mx-auto max-w-lg rounded-xl border border-ink-700 bg-white p-6 sm:p-8">
      <h1 className="text-[1.375rem] font-semibold text-cloud-50">{title}</h1>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-cloud-400">{body}</p>
      <div className="mt-6">
        <ButtonLink href={action.href} size="md">
          {action.label}
        </ButtonLink>
      </div>
    </div>
  );
}

