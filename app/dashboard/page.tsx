import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, FileText, Radar } from "lucide-react";

import { PageHeading, StatTile } from "@/components/dashboard/PageHeading";
import { QuickCheck } from "@/components/dashboard/QuickCheck";
import { ReportRow } from "@/components/dashboard/ReportRow";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SubscriptionBadge } from "@/components/ui/Badge";
import { requireUser } from "@/lib/auth/guard";
import { countReports, countWebsites, latestReport, listReports } from "@/lib/db/audits";
import { getActiveSubscription, getLatestSubscription } from "@/lib/db/billing";
import { entitlementBlock } from "@/lib/entitlement";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import { cn } from "@/lib/cn";

export const metadata: Metadata = {
  title: "Dashboard",
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();

  const active = getActiveSubscription(user.id);
  // Falls back to the most recent record so an expired plan can still be
  // shown with its real dates instead of disappearing.
  const subscription = active ?? getLatestSubscription(user.id);
  const blocked = entitlementBlock(active);

  const reports = listReports(user.id, 5);
  const total = countReports(user.id);
  const sites = countWebsites(user.id);
  const last = latestReport(user.id);
  const now = Date.now();

  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;
  const usedPct = subscription
    ? Math.min(
        100,
        Math.round((subscription.scansUsed / Math.max(subscription.scanLimit, 1)) * 100),
      )
    : 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeading
        eyebrow="Overview"
        title={
          <>
            Welcome back, <span className="grad-text">{firstName}</span>
          </>
        }
        lede={
          last
            ? `Last scan: ${last.domain} on ${formatDateTime(last.startedAt)}.`
            : "You have not run a scan yet. Enter a domain below and we will run every check your plan includes."
        }
        action={
          <ButtonLink href="/dashboard/checker" size="md">
            <Radar className="size-4" aria-hidden />
            New scan
          </ButtonLink>
        }
      />

      {/* ── entitlement warning ────────────────────────────────── */}
      {blocked ? (
        <div className="glass flex flex-col gap-3 rounded-xl border-amber-400/20 bg-amber-400/[0.05] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-400"
              aria-hidden
            />
            <p className="text-[0.9375rem] leading-snug text-cloud-200">
              {blocked.message}
            </p>
          </div>
          <ButtonLink href="/pricing" size="sm" className="shrink-0">
            See plans
          </ButtonLink>
        </div>
      ) : null}

      {/* ── plan + usage ───────────────────────────────────────── */}
      <section className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        <div className="glass edge-light relative overflow-hidden rounded-xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[0.8125rem] font-medium text-cloud-400">Current plan</p>
              <h2 className="t-display mt-2 text-[1.6rem] leading-none text-cloud-50">
                {subscription?.planName ?? "No plan"}
              </h2>
            </div>
            {subscription ? (
              <SubscriptionBadge status={subscription.status} />
            ) : null}
          </div>

          {subscription ? (
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
              <div>
                <dt className="text-[0.8125rem] font-medium text-cloud-600">
                  Started
                </dt>
                <dd className="t-data mt-1.5 text-[0.9375rem] text-cloud-200">
                  {formatDate(subscription.startsAt)}
                </dd>
              </div>
              <div>
                <dt className="text-[0.8125rem] font-medium text-cloud-600">
                  {subscription.isExpired ? "Expired" : "Valid until"}
                </dt>
                <dd className="t-data mt-1.5 text-[0.9375rem] text-cloud-200">
                  {formatDate(subscription.expiresAt)}
                </dd>
              </div>
              <div>
                <dt className="text-[0.8125rem] font-medium text-cloud-600">
                  Allowance resets
                </dt>
                <dd
                  className={cn(
                    "t-data mt-1.5 text-[0.9375rem]",
                    subscription.isCapped ? "text-amber-400" : "text-cloud-200",
                  )}
                >
                  {formatDate(subscription.cycleEnd)}
                </dd>
              </div>
              <div>
                <dt className="text-[0.8125rem] font-medium text-cloud-600">
                  Websites allowed
                </dt>
                <dd className="t-data mt-1.5 text-[0.9375rem] text-cloud-200">
                  {subscription.siteLimit === null
                    ? "Unlimited"
                    : subscription.siteLimit}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-5 text-[0.9375rem] text-cloud-400">
              Pick a plan to start scanning.
            </p>
          )}

          <div className="mt-6 border-t border-ink-700 pt-5">
            <div className="flex items-baseline justify-between">
              <p className="text-[0.8125rem] font-medium text-cloud-600">
                Scans this month
              </p>
              <p className="t-data text-[0.8125rem] text-cloud-400">
                {subscription
                  ? `${subscription.scansUsed} / ${subscription.scanLimit}`
                  : "—"}
              </p>
            </div>

            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink-900">
              <span
                className={cn(
                  "block h-full rounded-full transition-all duration-700",
                  usedPct >= 100 ? "bg-amber-400" : "grad-brand",
                )}
                style={{ width: `${usedPct}%` }}
              />
            </div>

            <p
              className={cn(
                "mt-2.5 text-[0.8125rem]",
                subscription?.isCapped ? "text-amber-400" : "text-cloud-600",
              )}
            >
              {!subscription
                ? "No scans available"
                : subscription.isCapped
                  ? `Monthly scan limit reached. Upgrade your plan or wait until your next billing cycle — the allowance resets on ${formatDate(subscription.cycleEnd)}.`
                  : `${plural(subscription.scansRemaining, "scan")} left until ${formatDate(subscription.cycleEnd)}`}
            </p>
          </div>

          <div className="mt-6 flex flex-wrap gap-2.5">
            <ButtonLink href="/dashboard/billing" variant="ghost" size="sm">
              Billing &amp; invoices
            </ButtonLink>
            <ButtonLink href="/pricing" variant="quiet" size="sm">
              {subscription?.isUsable ? "Change plan" : "See plans"}
            </ButtonLink>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="glass rounded-xl p-5 sm:p-6">
            <h2 className="t-h3 text-cloud-50">Quick website check</h2>
            <p className="mt-2 text-[0.9375rem] text-cloud-400">
              {blocked
                ? "Your plan cannot run a scan right now."
                : "Paste a domain to start a run."}
            </p>
            <div className="mt-4">
              <QuickCheck disabled={Boolean(blocked)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label="Scans run"
              value={total}
              hint="Kept even after a plan expires"
            />
            <StatTile
              label="Websites"
              value={sites}
              hint={
                subscription?.siteLimit
                  ? `Limit ${subscription.siteLimit}`
                  : undefined
              }
            />
            <StatTile
              label="Last website"
              value={
                last ? (
                  <span className="block truncate text-[1rem]">
                    {last.domain}
                  </span>
                ) : (
                  "—"
                )
              }
              className="col-span-2"
              hint={last ? formatDateTime(last.startedAt) : "No scans yet"}
            />
          </div>
        </div>
      </section>

      {/* ── recent reports ─────────────────────────────────────── */}
      <section>
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-[1.0625rem] font-semibold text-cloud-50">Recent reports</h2>
          {total > reports.length ? (
            <Link
              href="/dashboard/reports"
              className="text-[0.875rem] font-medium text-azure-600 hover:text-azure-500"
            >
              View all {total}
            </Link>
          ) : null}
        </div>

        <div className="mt-4">
          {reports.length === 0 ? (
            <EmptyState
              icon={<FileText className="size-5" aria-hidden />}
              title="No reports yet"
              body="Your first scan takes about half a minute. The report stays here permanently, so you can compare before and after each fix."
              action={{ label: "Run your first scan", href: "/dashboard/checker" }}
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {reports.map((report) => (
                <ReportRow key={report.id} report={report} now={now} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
