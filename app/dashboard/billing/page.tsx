import type { Metadata } from "next";
import {
  AlertTriangle,
  ChevronRight,
  CreditCard,
  Settings,
} from "lucide-react";

import { BillingHistoryTable } from "@/components/dashboard/BillingHistoryTable";
import { BillingPlanCards } from "@/components/dashboard/BillingPlanCards";
import { SubscriptionBadge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { requireUser } from "@/lib/auth/guard";
import {
  getActiveSubscription,
  getLatestSubscription,
  listInvoices,
  listPayments,
  listSubscriptions,
} from "@/lib/db/billing";
import { checkoutOptions, checkoutOptionsFor, gatewayLabel } from "@/lib/payments";
import { formatDate, plural } from "@/lib/format";
import { listActivePlans } from "@/lib/plan-catalogue";
import { formatMoney } from "@/lib/money";
import { siteCurrency } from "@/lib/site-currency";

export const metadata: Metadata = {
  title: "Billing",
};

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await requireUser();

  const active = getActiveSubscription(user.id);
  const current = active ?? getLatestSubscription(user.id);
  const history = listSubscriptions(user.id);
  const payments = listPayments(user.id);

  const invoices = listInvoices(user.id);
  const plans = listActivePlans();
  const currency = siteCurrency();
  const planNames = Object.fromEntries(plans.map((plan) => [plan.id, plan.name]));

  const options = checkoutOptions();

  const simulated =
    options.length > 0 &&
    options.every((option) => option.simulated);

  const sandbox = options.filter(
    (option) =>
      !option.simulated &&
      option.environment === "sandbox",
  );

  const methodNames = options.map(
    (option) => option.label,
  );

  const paid = payments.filter(
    (payment) => payment.status === "paid",
  );

  // Totalled per currency: rupees and dollars are never added together.
  const totals = new Map<string, number>();
  for (const payment of paid) {
    totals.set(payment.currency, (totals.get(payment.currency) ?? 0) + payment.amountPaise);
  }
  const totalPaidLabel =
    totals.size === 0
      ? formatMoney(0, siteCurrency())
      : [...totals.entries()].map(([currency, minor]) => formatMoney(minor, currency)).join(" + ");

  const scanPercentage =
    current && current.scanLimit > 0
      ? Math.min(
          (current.scansUsed /
            current.scanLimit) *
            100,
          100,
        )
      : 0;

  return (
    <div className="w-full space-y-6">
      {/* ── Header ───────────────────────────────────────────── */}
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-[1.5rem] font-bold tracking-tight text-cloud-50 sm:text-[1.75rem]">
            Billing &amp; Subscription
          </h1>
          
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Plans are sold monthly only, so this states the period rather than offering a switch. */}
          <span className="inline-flex rounded-full border border-ink-700 bg-ink-900 p-1">
            <span className="rounded-full bg-white px-4 py-1.5 text-[0.8125rem] font-medium text-cloud-50 shadow-[0_1px_2px_rgba(24,24,27,0.08)]">
              Monthly
            </span>
          </span>
          <ButtonLink href="/pricing" size="md" variant="ghost">
            <CreditCard className="size-4" aria-hidden />
            {active?.isUsable ? "Change plan" : "See plans"}
          </ButtonLink>
        </div>
      </section>

      {/* ── Payment environment notice ───────────────────────── */}
      {options.length === 0 ? (
        <div className="relative overflow-hidden rounded-xl border border-amber-400/35 bg-amber-400/[0.06] px-5 py-4">

          <div className="flex items-start gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-amber-400/30 bg-amber-400/10">
              <AlertTriangle
                className="size-5 text-amber-400"
                aria-hidden
              />
            </div>

            <div>
              <p className="text-[0.9375rem] font-semibold text-cloud-50">
                Online payment is unavailable.
              </p>

              <p className="mt-1 text-[0.9375rem] leading-relaxed text-cloud-300">
                No payment method is enabled at the
                moment, so a plan cannot be started or
                changed right now. Nothing has been
                charged. Your existing plan and reports
                are unaffected.
              </p>
            </div>
          </div>
        </div>
      ) : simulated ? (
        <div className="relative overflow-hidden rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-5 py-4">
          <div className="flex items-start gap-4">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-amber-400/25 bg-amber-400/10">
              <AlertTriangle
                className="size-4 text-amber-400"
                aria-hidden
              />
            </div>

            <p className="pt-0.5 text-[0.9375rem] leading-relaxed text-cloud-200">
              <span className="font-semibold text-cloud-50">
                Test mode.
              </span>{" "}
              Purchases are simulated locally and stored
              as test payments. No money moves and no
              gateway is contacted.
            </p>
          </div>
        </div>
      ) : sandbox.length > 0 ? (
        <div className="relative overflow-hidden rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-5 py-4">
          <div className="flex items-start gap-4">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-amber-400/25 bg-amber-400/10">
              <AlertTriangle
                className="size-4 text-amber-400"
                aria-hidden
              />
            </div>

            <p className="pt-0.5 text-[0.9375rem] leading-relaxed text-cloud-200">
              <span className="font-semibold text-cloud-50">
                Sandbox mode.
              </span>{" "}
              {sandbox
                .map((option) => option.label)
                .join(", ")}{" "}
              {sandbox.length === 1
                ? "is"
                : "are"}{" "}
              running against test credentials, so
              payments are not real charges.
            </p>
          </div>
        </div>
      ) : null}

      {/* ── Plans ────────────────────────────────────────────── */}
      <BillingPlanCards plans={plans} current={active ?? null} currency={currency} options={checkoutOptionsFor(currency)} />

      {/* ── Your subscription ─────────────────────────────────── */}
      <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-ink-700 bg-white p-5 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[0.8125rem] font-medium text-cloud-400">Current plan</p>
              <h2 className="mt-0.5 text-[1.25rem] font-semibold tracking-tight text-cloud-50">
                {current?.planName ?? "No plan"}
              </h2>
            </div>
            {current ? <SubscriptionBadge status={current.status} /> : null}
          </div>

          {current ? (
            <>
              <div className="mt-5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[0.875rem]">
                  <span className="text-cloud-400">Scans this month</span>
                  <span className="font-medium text-cloud-100">
                    {current.scansUsed} of {current.scanLimit} used · {current.scansRemaining} left
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-850">
                  <div
                    className="h-full rounded-full bg-zinc-900"
                    style={{ width: `${Math.max(scanPercentage, current.scansUsed > 0 ? 3 : 0)}%` }}
                  />
                </div>
              </div>

              <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-ink-700 pt-5 sm:grid-cols-2 lg:grid-cols-3">
                <Detail label="Monthly price">{`${formatMoney(current.amountPaise, current.currency)} / month`}</Detail>
                <Detail label="Started">{formatDate(current.startsAt)}</Detail>
                <Detail label={current.isExpired ? "Expired on" : "Valid until"}>{formatDate(current.expiresAt)}</Detail>
                <Detail label="Billing month">
                  {current.cycleIndex} · {formatDate(current.cycleStart)} → {formatDate(current.cycleEnd)}
                </Detail>
                <Detail label="Allowance resets">{formatDate(current.cycleEnd)}</Detail>
                <Detail label="Websites allowed">{current.siteLimit === null ? "Unlimited" : current.siteLimit}</Detail>
                <Detail label="Paid with">{current.gateway ? gatewayLabel(current.gateway) : "—"}</Detail>
                <Detail label="Order ID" mono>{current.orderId ?? "—"}</Detail>
                <Detail label="Payment ID" mono>{current.paymentId ?? "—"}</Detail>
                <Detail label="Invoice ID" mono>{current.invoiceId ?? "—"}</Detail>
              </dl>

              {current.isCapped && !current.isExpired ? (
                <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-[0.875rem] leading-relaxed text-amber-400">
                  Monthly scan limit reached. Upgrade your plan or wait until your next billing cycle — the
                  allowance resets on {formatDate(current.cycleEnd)}.
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-4 max-w-xl text-[0.9375rem] leading-relaxed text-cloud-300">
              You are not on a plan yet. The free tier gives you a small allowance of scans every month;
              paid plans raise that allowance and unlock deeper checks.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-ink-700 bg-white p-5 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:p-6">
            <p className="text-[0.8125rem] font-medium text-cloud-400">Paid so far</p>
            <p className="t-data mt-1 text-[1.75rem] font-bold tracking-tight text-cloud-50">{totalPaidLabel}</p>
            <p className="mt-3 text-[0.875rem] leading-relaxed text-cloud-400">
              Across {plural(paid.length, "successful payment")}. Plans are billed per month
              {active && !active.isExpired ? `, and this one runs until ${formatDate(active.expiresAt)}` : ""}.
              Changing plan applies from the next payment; the month you have already paid for is never
              shortened.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <ButtonLink href="/pricing" size="md" className="px-5">
                {active?.isUsable ? "Change plan" : "See plans"}
                <ChevronRight className="size-4" aria-hidden />
              </ButtonLink>
              <ButtonLink href="/dashboard/settings" variant="quiet" size="md" className="px-5">
                <Settings className="size-4" aria-hidden />
                Account settings
              </ButtonLink>
            </div>
          </div>

          {history.length > 1 ? (
            <div className="rounded-2xl border border-ink-700 bg-white p-5 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:p-6">
              <p className="text-[0.8125rem] font-medium text-cloud-400">Plan history</p>
              <ul className="mt-3 divide-y divide-ink-850">
                {history.map((subscription) => (
                  <li key={subscription.id} className="flex items-center justify-between gap-4 py-3 first:pt-1 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-[0.9375rem] font-medium text-cloud-50">{subscription.planName}</p>
                      <p className="mt-0.5 text-[0.8125rem] text-cloud-400">
                        {formatDate(subscription.startsAt)} → {formatDate(subscription.expiresAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-[0.875rem] font-medium text-cloud-200" title="Scans used in this subscription's current billing month">
                        {subscription.scansUsed}/{subscription.scanLimit}
                      </span>
                      <SubscriptionBadge status={subscription.status} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Billing history ───────────────────────────────────── */}
      <BillingHistoryTable payments={payments} invoices={invoices} subscriptions={history} planNames={planNames} />

      
    </div>
  );
}

/* ── Detail ─────────────────────────────────────────────────── */

function Detail({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.8125rem] text-cloud-400">{label}</dt>
      <dd
        className={
          mono
            ? "t-data mt-0.5 break-all text-[0.8125rem] text-cloud-200"
            : "mt-0.5 text-[0.9375rem] font-medium text-cloud-50"
        }
      >
        {children}
      </dd>
    </div>
  );
}
