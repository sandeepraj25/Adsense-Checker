import Link from "next/link";
import {
  CreditCard,
  FileText,
  Globe,
  RefreshCw,
  ShieldAlert,
  UserPlus,
  Users,
} from "lucide-react";

import { Panel, StatGrid, TableShell, Td, Th, Tr } from "@/components/admin/Panels";
import { PageHeading, StatTile } from "@/components/dashboard/PageHeading";
import { ButtonLink } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { requireAdmin } from "@/lib/auth/guard";
import { adminStats, recentActivity } from "@/lib/db/admin";
import { formatAge } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { gatewayLabel, gatewayViews } from "@/lib/payments";
import { listPlans } from "@/lib/plan-catalogue";
import { currencyReadiness } from "@/lib/currency-readiness";
import { siteCurrency } from "@/lib/site-currency";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Overview — Admin",
};

export default async function AdminOverviewPage() {
  const admin = await requireAdmin();
  const stats = adminStats();
  const activity = recentActivity(14);
  const plans = listPlans();
  const gateways = gatewayViews();
  const now = Date.now();

  const liveGateways = gateways.filter((view) => view.enabled);

  const scanTotal = stats.scans.total;

  const successRate =
    scanTotal > 0
      ? Math.round((stats.scans.successful / scanTotal) * 100)
      : null;

  const totalAccounts = Math.max(1, plans.reduce((sum, plan) => sum + (stats.plans[plan.id] ?? 0), 0));

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow="Administration"
        title="Overview"
        lede={`Signed in as ${admin.email}. Figures are read live from the database.`}
        action={
          <ButtonLink href="/admin" variant="ghost" size="sm">
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </ButtonLink>
        }
      />

      {(() => {
        const site = siteCurrency();
        const ready = currencyReadiness(site);
        if (ready.ready) return null;
        return (
          <div role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/[0.07] px-4 py-3 text-[0.9375rem] leading-relaxed">
            <p className="font-semibold text-cloud-50">Customers can&apos;t buy every plan in {site}, the website currency</p>
            <p className="mt-0.5 text-cloud-300">
              {ready.missingPrices.length ? `No ${site} price for ${ready.missingPrices.map((p) => p.name).join(", ")}. ` : ""}
              {ready.payableBy.length ? "" : `No enabled payment gateway takes ${site}. `}
              <Link href="/admin/settings/currency" className="font-medium text-azure-600 hover:underline">
                Review the website currency
              </Link>
            </p>
          </div>
        );
      })()}

      <section aria-labelledby="accounts-heading" className="space-y-3">
        <h2 id="accounts-heading" className="text-[1rem] font-semibold text-cloud-50">
          Accounts
        </h2>
        <StatGrid>
          <StatTile
            label="Registered users"
            value={stats.users.total}
            hint={`${stats.users.admins} administrator${stats.users.admins === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Active"
            value={stats.users.active}
            hint={
              stats.users.total > 0
                ? `${Math.round((stats.users.active / stats.users.total) * 100)}% of accounts`
                : "No users yet"
            }
          />
          <StatTile
            label="Suspended"
            value={stats.users.blocked}
            tone={stats.users.blocked > 0 ? "warn" : "default"}
            hint={stats.users.blocked > 0 ? "Cannot sign in" : "None blocked"}
          />
          <StatTile
            label="Verified revenue"
            value={formatMoney(stats.revenueByCurrency.INR, "INR")}
            hint={stats.revenueByCurrency.USD > 0 ? `+ ${formatMoney(stats.revenueByCurrency.USD, "USD")} · live payments only` : "Live payments only"}
          />
        </StatGrid>
      </section>

      <section aria-labelledby="usage-heading" className="space-y-3">
        <h2 id="usage-heading" className="text-[1rem] font-semibold text-cloud-50">
          Subscriptions, scans and payments
        </h2>
        <StatGrid>
          <StatTile
            label="Active subscriptions"
            value={stats.subscriptions.active}
            hint={`${stats.subscriptions.paid} ever paid for`}
          />
          <StatTile
            label="Expired"
            value={stats.subscriptions.expired}
            hint={`${stats.subscriptions.cancelled} cancelled`}
          />
          <StatTile label="Websites" value={stats.websites} />
          <StatTile
            label="Reports"
            value={stats.reports.total}
            hint={stats.reports.running > 0 ? `${stats.reports.running} running now` : "None running"}
          />
          <StatTile label="Scans attempted" value={stats.scans.total} />
          <StatTile
            label="Successful scans"
            value={stats.scans.successful}
            tone={stats.scans.successful > 0 ? "pass" : "default"}
            hint={successRate === null ? "No scans yet" : `${successRate}% of attempts`}
          />
          <StatTile
            label="Failed scans"
            value={stats.scans.failed}
            tone={stats.scans.failed > 0 ? "fail" : "default"}
            hint="Unreachable sites and aborted runs"
          />
          <StatTile
            label="Payments"
            value={stats.payments.total}
            hint={`${stats.payments.paid} paid · ${stats.payments.failed} failed`}
          />
        </StatGrid>
      </section>

      <Panel
        title="Plan mix"
        description="Accounts counted by the plan on their live subscription."
        action={
          <ButtonLink href="/admin/plans" variant="ghost" size="sm">
            Edit plans
          </ButtonLink>
        }
      >
        <TableShell
          className="[&_table]:min-w-[34rem]"
          head={
            <>
              <Th>Plan</Th>
              <Th>Price</Th>
              <Th>Limits</Th>
              <Th className="text-right">Accounts</Th>
            </>
          }
        >
          {plans.map((plan) => {
            const count = stats.plans[plan.id] ?? 0;
            const share = Math.round((count / totalAccounts) * 100);
            return (
              <Tr key={plan.id}>
                <Td>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-cloud-50">{plan.name}</span>
                    {plan.active && plan.featured ? <Badge tone="brand">Highlighted</Badge> : null}
                    {!plan.active ? <Badge tone="warn">Inactive</Badge> : null}
                  </span>
                </Td>
                <Td mono>
                  {plan.amountPaise === 0
                    ? "Free"
                    : `${formatMoney(plan.amountPaise, "INR")}${plan.usdAmountCents !== null ? ` · ${formatMoney(plan.usdAmountCents, "USD")}` : ""}/month`}
                </Td>
                <Td>
                  {plan.scanLimit} scans · {plan.siteLimit} site{plan.siteLimit === 1 ? "" : "s"}
                </Td>
                <Td className="text-right">
                  <span className="inline-flex items-center justify-end gap-3">
                    <span
                      aria-hidden
                      className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-ink-850 sm:block"
                    >
                      <span className="block h-full rounded-full bg-azure-500" style={{ width: `${share}%` }} />
                    </span>
                    <span className="t-data w-8 font-semibold text-cloud-50">{count}</span>
                  </span>
                </Td>
              </Tr>
            );
          })}
        </TableShell>
      </Panel>

      <Panel
        title="Checkout readiness"
        description={
          liveGateways.length === 0
            ? "No payment gateway is enabled, so nobody can buy a plan. Configure one before announcing pricing."
            : "Customers can choose any enabled gateway at checkout."
        }
        action={
          <ButtonLink href="/admin/payment-gateways" variant="ghost" size="sm">
            Configure
          </ButtonLink>
        }
      >
        <ul className="grid gap-2 sm:grid-cols-3">
          {gateways.map((view) => (
            <li
              key={view.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 px-3.5 py-3 text-[0.875rem]"
            >
              <span className="inline-flex items-center gap-2 font-medium text-cloud-50">
                <CreditCard className="size-4 text-cloud-400" aria-hidden />
                {gatewayLabel(view.id)}
              </span>
              {view.enabled ? (
                <Badge tone={view.environment === "live" ? "pass" : "warn"} dot>
                  {view.environment === "live" ? "Live" : "Sandbox"}
                </Badge>
              ) : (
                <Badge tone="neutral">{view.configured ? "Disabled" : "Not configured"}</Badge>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="Recent activity"
        description="Signups, scans, payments and administrative changes, newest first."
        action={
          <ButtonLink href="/admin/logs" variant="ghost" size="sm">
            Full audit log
          </ButtonLink>
        }
      >
        {activity.length === 0 ? (
          <p className="py-6 text-center text-[0.875rem] text-cloud-400">Nothing has happened yet.</p>
        ) : (
          <ul className="-my-1 divide-y divide-ink-850">
            {activity.map((entry, index) => (
              <li key={`${entry.kind}-${entry.at}-${index}`} className="flex items-center gap-3 py-3">
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-900 text-cloud-300"
                >
                  <ActivityIcon kind={entry.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.875rem] font-medium text-cloud-50">{entry.title}</p>
                  <p className="mt-0.5 truncate text-[0.8125rem] text-cloud-400">{entry.detail}</p>
                </div>
                <span className="t-data shrink-0 text-[0.8125rem] text-cloud-400">{formatAge(entry.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="flex flex-wrap gap-2">
        <ButtonLink href="/admin/users" variant="ghost" size="sm">
          <Users className="size-4" aria-hidden />
          Manage users
        </ButtonLink>
        <ButtonLink href="/admin/subscriptions" variant="ghost" size="sm">
          <FileText className="size-4" aria-hidden />
          Subscriptions and payments
        </ButtonLink>
      </div>
    </div>
  );
}

/* ================================================================
   ACTIVITY ICON
================================================================ */

function ActivityIcon({
  kind,
}: {
  kind: "signup" | "scan" | "payment" | "admin";
}) {
  const className = "size-4";

  if (kind === "signup") {
    return <UserPlus className={className} />;
  }

  if (kind === "scan") {
    return <Globe className={className} />;
  }

  if (kind === "payment") {
    return <CreditCard className={className} />;
  }

  return <ShieldAlert className={className} />;
}