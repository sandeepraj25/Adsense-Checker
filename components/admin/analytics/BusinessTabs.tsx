import Link from "next/link";
import { XCircle } from "lucide-react";

import { NoRows, TableShell, Td, Th, Tr } from "@/components/admin/Panels";
import { Badge } from "@/components/ui/Badge";
import { formatMoney, type Currency } from "@/lib/money";
import type { Funnel } from "@/lib/analytics/funnel";
import { reportHref, type ReportQuery } from "@/lib/analytics/report";
import { accountsSection, funnelSection, healthSection, revenueSection, scansSection } from "@/lib/analytics/sections";
import type { AnalyticsSettings } from "@/lib/analytics/settings";
import { TrendChart } from "./Charts";
import { fmtDateIn, fmtDuration, fmtInt, fmtPct } from "./format";
import { BarList, ChangePill, Definition, ExportLink, Pager, Section, Stat } from "./Parts";
import { COLORS, CoverageNotice, exportHref } from "./TrafficTabs";

/* ── funnel ─────────────────────────────────────────────────────── */

function FunnelView({ funnel, previous }: { funnel: Funnel; previous: Funnel }) {
  const first = funnel.steps[0]?.count ?? 0;
  if (first === 0) return <NoRows>Nobody reached the first step in this period.</NoRows>;
  return (
    <div>
      <ol className="space-y-2.5">
        {funnel.steps.map((step, i) => {
          const prev = previous.steps[i]?.count ?? 0;
          return (
            <li key={step.key} className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] sm:items-center">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="t-data grid size-6 shrink-0 place-items-center rounded-md bg-ink-850 text-[0.75rem] text-cloud-300">{i + 1}</span>
                <span className="truncate text-[0.875rem] text-cloud-100">{step.label}</span>
                <Definition label={step.label} text={step.definition} />
              </div>
              <div className="relative h-7 overflow-hidden rounded-md bg-ink-850" aria-hidden>
                <div className="absolute inset-y-0 left-0 rounded-md bg-azure-500/70" style={{ width: `${Math.max(step.count ? 1.5 : 0, (step.count / first) * 100)}%` }} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] sm:justify-end">
                <span className="t-data w-14 text-right font-semibold text-cloud-50">{fmtInt(step.count)}</span>
                <span className="w-28 whitespace-nowrap text-cloud-400">{i === 0 ? "start" : step.fromPrevious === null ? "—" : `${fmtPct(step.fromPrevious, 0)} of previous`}</span>
                <span className="w-28 whitespace-nowrap text-cloud-400">{i === 0 ? "" : step.dropOff ? `−${fmtInt(step.dropOff)} (${fmtPct(step.dropOffRate, 0)})` : "no drop-off"}</span>
                <span className="w-24">
                  <ChangePill current={step.count} previous={prev} format="int" />
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-[0.8125rem] leading-relaxed text-cloud-400">
        Overall: <span className="font-semibold text-cloud-50">{fmtPct(funnel.overall)}</span> of {funnel.unit} reached the last step (previous period {fmtPct(previous.overall)}).
        Denominator: {funnel.denominator}
      </p>
    </div>
  );
}

export function FunnelTab({ query, settings }: { query: ReportQuery; settings: AnalyticsSettings }) {
  const d = funnelSection(query);
  return (
    <div className="space-y-6">
      <CoverageNotice coverage={d.coverage} settings={settings} />
      <Section
        title="Visitor journey"
        description="Tracked visitors who went through each step in order during the period. Payment, account and scan steps come from the server, never from the browser. In cookie-free mode a visitor is recognised for one day, so journeys spread over several days are split."
        action={<ExportLink href={exportHref(query, "funnel")} enabled={settings.exportEnabled} />}
      >
        <FunnelView funnel={d.journey} previous={d.journeyPrevious} />
        {d.journey.extra?.paymentFailed ? (
          <p className="mt-2 text-[0.8125rem] text-rose-400">
            {fmtInt(d.journey.extra.paymentFailed)} visitor{d.journey.extra.paymentFailed === 1 ? "" : "s"} started a payment that then failed or was cancelled.
          </p>
        ) : null}
      </Section>
      <Section
        title="Account funnel (from records)"
        description="Accounts registered in the period and what they have done since, up to now. Works for dates before tracking began. Live payments only."
      >
        <FunnelView funnel={d.accounts} previous={d.accountsPrevious} />
      </Section>
    </div>
  );
}

/* ── accounts ───────────────────────────────────────────────────── */

const SUB_STATUS: Record<string, "pass" | "warn" | "fail" | "neutral"> = { active: "pass", expired: "warn", cancelled: "fail" };

export function AccountsTab({ query, settings }: { query: ReportQuery; settings: AnalyticsSettings }) {
  const d = accountsSection(query);
  const a = d.report;
  const p = d.previous;
  return (
    <div className="space-y-6">
      <Section title="Accounts" description="Administrator accounts are excluded throughout." action={<ExportLink href={exportHref(query, "accounts")} enabled={settings.exportEnabled} />}>
        <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Registered users" value={fmtInt(a.totalUsers)} hint="at the end of the period" />
          <Stat label="New accounts" value={fmtInt(a.newUsers)} hint={<ChangePill current={a.newUsers} previous={p.newUsers} format="int" />} />
          <Stat
            label="Active accounts"
            value={fmtInt(a.activeUsers)}
            hint={<ChangePill current={a.activeUsers} previous={p.activeUsers} format="int" />}
            definition="Accounts with at least one scan, payment attempt, or signed-in tracked visit in the period. The app has never stored a general last-seen time, so other activity can't be counted."
          />
          <Stat label="Returning accounts" value={fmtInt(a.returningUsers)} hint="active, registered before the period" />
          <Stat
            label="Registration conversion"
            value={d.coverage.tracked ? fmtPct(d.visitors ? a.newUsers / d.visitors : null) : "—"}
            hint={d.coverage.state === "full" ? "new accounts ÷ visitors" : "needs tracked visits for the whole period"}
            definition="New accounts ÷ tracked visitors in the period."
          />
          <Stat
            label="Verification completion"
            value={fmtPct(a.verificationCompletion)}
            hint={a.signupForms ? `${fmtInt(a.emailVerifications)} of ${fmtInt(a.signupForms)} sign-up forms` : "no tracked sign-up forms"}
            definition="Accounts created by confirming the emailed code ÷ sign-up forms that sent a code (tracked since analytics was added). Repeat forms for one address on one day count once."
          />
        </dl>
        <TrendChart
          title="New and active accounts"
          labels={d.buckets.map((b) => b.label)}
          series={[
            { name: "New accounts", values: a.registrations, color: COLORS.indigo },
            { name: "Active accounts", values: a.activeSeries, color: COLORS.teal },
          ]}
        />
        {a.verificationNotRecorded ? (
          <p className="mt-3 text-[0.8125rem] text-cloud-400">
            {fmtInt(a.verificationNotRecorded)} older account{a.verificationNotRecorded === 1 ? " was" : "s were"} created before email verification existed; their verification date is not recorded (not the same as unverified).
          </p>
        ) : null}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Plans and subscription changes" description="Subscriptions created, expired or cancelled in the period.">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="First paid plan" value={fmtInt(a.subscriptionChanges.firstPurchase)} />
            <Stat label="Repeat or upgrade" value={fmtInt(a.subscriptionChanges.repeatPurchase)} definition="A paid plan bought by an account that had bought one before." />
            <Stat label="Assigned by admin" value={fmtInt(a.subscriptionChanges.adminAssigned)} />
            <Stat label="Expired" value={fmtInt(a.subscriptionChanges.expired)} />
            <Stat label="Cancelled" value={fmtInt(a.subscriptionChanges.cancelled)} definition="Subscriptions set to cancelled, dated by their last update — so approximate." />
          </dl>
        </Section>
        <Section title="Recently registered">
          {a.recent.length === 0 ? (
            <NoRows>No accounts yet.</NoRows>
          ) : (
            <ul className="divide-y divide-ink-850">
              {a.recent.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-[0.875rem]">
                  <Link href={`/admin/users/${u.id}`} className="truncate text-cloud-100 hover:text-azure-600">
                    {u.name}
                  </Link>
                  <span className="shrink-0 text-cloud-400">{fmtDateIn(u.createdAt, query.range.tz)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section
        title="Retention by registration month"
        description="Share of each month's new accounts that ran at least one scan in each following month (reporting timezone). Scans are used because they're recorded for every account since launch."
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[28rem] text-left text-[0.875rem]">
            <thead>
              <tr className="border-b border-ink-700 text-[0.75rem] text-cloud-400">
                <th scope="col" className="py-2 pr-3 font-medium">Cohort</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Accounts</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Month 1</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Month 2</th>
                <th scope="col" className="py-2 text-right font-medium">Month 3</th>
              </tr>
            </thead>
            <tbody>
              {d.cohorts.map((c) => (
                <tr key={c.label} className="border-b border-ink-850 last:border-0">
                  <td className="py-2 pr-3 text-cloud-100">{c.label}</td>
                  <td className="t-data py-2 pr-3 text-right text-cloud-200">{fmtInt(c.size)}</td>
                  {c.months.map((m, i) => (
                    <td key={i} className="t-data py-2 pr-3 text-right last:pr-0">
                      {m === null ? (
                        <span className="text-cloud-400">—</span>
                      ) : (
                        <span className="rounded px-1.5 py-0.5 text-cloud-50" style={{ background: `rgba(79,70,229,${0.06 + m * 0.5})` }}>
                          {fmtPct(m, 0)}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="All accounts"
        description="Newest first. Last activity is the latest scan, payment or signed-in tracked visit on record; “No activity recorded” means none of those exist."
        action={<ExportLink href={exportHref(query, "users")} enabled={settings.exportEnabled} label={settings.exportIncludesEmail ? "CSV (with emails)" : "CSV"} />}
      >
        {d.users.total === 0 ? (
          <NoRows>No customer accounts yet.</NoRows>
        ) : (
          <>
            <TableShell
              head={
                <>
                  <Th>Account</Th>
                  <Th>Registered</Th>
                  <Th>Email verified</Th>
                  <Th>Last activity</Th>
                  <Th>Plan</Th>
                  <Th className="text-right">Scans</Th>
                </>
              }
            >
              {d.users.rows.map((u) => (
                <Tr key={u.id}>
                  <Td>
                    <Link href={`/admin/users/${u.id}`} className="font-medium text-cloud-50 hover:text-azure-600">
                      {u.name}
                    </Link>
                    <p className="text-[0.8125rem] text-cloud-400">{u.email}</p>
                    {u.accountStatus !== "active" ? <Badge tone="fail" className="mt-1">Blocked</Badge> : null}
                  </Td>
                  <Td mono>{fmtDateIn(u.createdAt, query.range.tz)}</Td>
                  <Td>{u.verifiedAt ? <span className="t-data text-[0.8125rem]">{fmtDateIn(u.verifiedAt, query.range.tz)}</span> : <span className="text-[0.8125rem] text-cloud-400">Not recorded</span>}</Td>
                  <Td>{u.lastActivityAt ? <span className="t-data text-[0.8125rem]">{fmtDateIn(u.lastActivityAt, query.range.tz, true)}</span> : <span className="text-[0.8125rem] text-cloud-400">No activity recorded</span>}</Td>
                  <Td>
                    {u.planName ?? "—"}
                    {u.subscriptionStatus ? (
                      <Badge tone={SUB_STATUS[u.subscriptionStatus] ?? "neutral"} className="ml-1.5">
                        {u.subscriptionStatus}
                      </Badge>
                    ) : null}
                  </Td>
                  <Td mono className="text-right">{fmtInt(u.scans)}</Td>
                </Tr>
              ))}
            </TableShell>
            <Pager page={d.users.page} total={d.users.total} pageSize={d.users.pageSize} href={(page) => reportHref(query, { up: page })} />
          </>
        )}
      </Section>
    </div>
  );
}

/* ── scans ──────────────────────────────────────────────────────── */

export function ScansTab({ query, settings }: { query: ReportQuery; settings: AnalyticsSettings }) {
  const d = scansSection(query);
  const s = d.report;
  const p = d.previous;
  return (
    <div className="space-y-6">
      <Section title="Eligibility scans" description="From scan reports. A scan is counted when it is charged and started; requests refused before charging are not scans." action={<ExportLink href={exportHref(query, "scans")} enabled={settings.exportEnabled} />}>
        <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Started" value={fmtInt(s.started)} hint={<ChangePill current={s.started} previous={p.started} format="int" />} />
          <Stat label="Completed" value={fmtInt(s.completed)} hint={<ChangePill current={s.completed} previous={p.completed} format="int" />} />
          <Stat label="Failed" value={fmtInt(s.failed)} hint={<ChangePill current={s.failed} previous={p.failed} format="int" lowerIsBetter />} />
          <Stat label="Completion rate" value={fmtPct(s.completionRate)} definition="Completed ÷ (completed + failed). Scans still running are left out." />
          <Stat label="Avg. processing time" value={fmtDuration(s.avgDurationMs)} hint={s.medianDurationMs !== null ? `median ${fmtDuration(s.medianDurationMs)}` : undefined} />
          <Stat label="Accounts scanning" value={fmtInt(s.scanners)} />
        </dl>
        <TrendChart
          title="Scan volume"
          labels={d.buckets.map((b) => b.label)}
          series={[
            { name: "Started", values: s.series.started, color: COLORS.indigo },
            { name: "Completed", values: s.series.completed, color: COLORS.teal },
            { name: "Failed", values: s.series.failed, color: COLORS.rose },
          ]}
          emptyText="No scans in this period."
        />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Results" description="Verdicts of completed scans, as the scanner reported them.">
          <BarList rows={s.verdicts} valueLabel="Scans" empty="No completed scans." />
          {s.scoreBands.length ? (
            <div className="mt-4">
              <BarList rows={s.scoreBands} valueLabel="Scans" empty="" />
            </div>
          ) : null}
        </Section>
        <Section title="Usage by plan" description="Plan the scan was charged to, with the number of accounts.">
          <BarList rows={s.byPlan} valueLabel="Scans" secondaryLabel="Accounts" empty="No scans." />
          <div className="mt-4">
            <BarList rows={s.freeVsPaid} valueLabel="Scans" empty="" />
          </div>
        </Section>
        <Section title="Repeat usage" description="Accounts by how many scans they ran in the period.">
          <BarList rows={s.repeatUsage.filter((r) => r.value > 0)} valueLabel="Accounts" empty="No scans." />
        </Section>
        <Section title="Conversion from free scans" description="Accounts that scanned on the free plan in the period and later made a verified live payment.">
          <dl className="grid grid-cols-3 gap-4">
            <Stat label="Free-plan scanners" value={fmtInt(s.freeScanners)} />
            <Stat label="Paid afterwards" value={fmtInt(s.freeScannersWhoPaid)} />
            <Stat label="Scan → purchase" value={fmtPct(s.freeScanners ? s.freeScannersWhoPaid / s.freeScanners : null)} />
          </dl>
          <p className="mt-3 text-[0.8125rem] text-cloud-400">Scanning needs an account, so every scan follows a sign-up; scan → sign-up conversion doesn&apos;t apply.</p>
        </Section>
        <Section title="Failure reasons" description="The message shown to the customer for each failed scan.">
          <BarList rows={s.failureReasons} valueLabel="Scans" empty="No failed scans in this period." />
          <p className="mt-3 text-[0.8125rem] leading-relaxed text-cloud-400">
            When a customer re-scans a site, the app removes that site&apos;s earlier failed reports, so record-based failure counts are a lower bound. Since tracking began, every
            failure is also logged as an event: {fmtInt(s.trackedFailures)} in this period.
            {s.demoFallbacks ? ` ${fmtInt(s.demoFallbacks)} scan${s.demoFallbacks === 1 ? "" : "s"} used the offline sample because the site couldn't be reached.` : ""}
          </p>
        </Section>
        <Section title="Usage limits reached" description="Scan requests refused by plan limits (tracked since analytics was added).">
          <BarList rows={s.blocked} valueLabel="Times" empty="No limits were hit in this period." />
        </Section>
      </div>
    </div>
  );
}

/* ── revenue ────────────────────────────────────────────────────── */

const CURRENCY_LIST: Currency[] = ["INR", "USD"];

export function RevenueTab({ query, settings }: { query: ReportQuery; settings: AnalyticsSettings }) {
  const d = revenueSection(query);
  const r = d.report;
  const p = d.previous;
  const labels = d.buckets.map((b) => b.label);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {CURRENCY_LIST.map((currency) => (
          <div key={currency} className="glass rounded-xl px-4 py-4">
            <div className="flex items-center gap-1">
              <p className="text-[0.8125rem] font-medium text-cloud-300">Revenue in {currency}</p>
              <Definition label={`Revenue in ${currency}`} text="Gross = verified live payments in this currency. Net = gross − refunds and chargebacks; this app does not record refunds, so net equals gross." />
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-3">
              <div>
                <dt className="text-[0.75rem] text-cloud-400">Gross</dt>
                <dd className="t-data text-[1.25rem] font-semibold text-cloud-50">{formatMoney(r.gross[currency], currency)}</dd>
                <dd>
                  <ChangePill current={r.gross[currency]} previous={p.gross[currency]} format="int" />
                </dd>
              </div>
              <div>
                <dt className="text-[0.75rem] text-cloud-400">Refunds</dt>
                <dd className="mt-1 text-[0.8125rem] text-cloud-400">Not recorded</dd>
              </div>
              <div>
                <dt className="text-[0.75rem] text-cloud-400">Net</dt>
                <dd className="t-data text-[1.25rem] font-semibold text-cloud-50">{formatMoney(r.net[currency], currency)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <Section title="Payments" description="Live mode only. Pending and failed payments are never counted as revenue." action={<ExportLink href={exportHref(query, "revenue")} enabled={settings.exportEnabled} />}>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Successful" value={fmtInt(r.paidCount)} hint={<ChangePill current={r.paidCount} previous={p.paidCount} format="int" />} />
          <Stat label="Failed" value={fmtInt(r.failedCount)} hint={<ChangePill current={r.failedCount} previous={p.failedCount} format="int" lowerIsBetter />} />
          <Stat label="Cancelled" value={fmtInt(r.cancelledCount)} />
          <Stat label="Pending" value={fmtInt(r.pendingCount)} definition="Orders opened in the period that the gateway hasn't confirmed or failed yet." />
          <Stat label="Success rate" value={fmtPct(r.successRate)} definition="Of live orders opened in the period that reached an outcome: paid ÷ (paid + failed + cancelled)." />
          <Stat label="Customers" value={fmtInt(r.newCustomers + r.returningCustomers)} hint={`${fmtInt(r.newCustomers)} new · ${fmtInt(r.returningCustomers)} returning`} definition="Accounts that paid in the period. New: their first verified live payment ever is in this period." />
        </dl>
        {r.testModePaid ? <p className="mt-3 text-[0.8125rem] text-cloud-400">{fmtInt(r.testModePaid)} test-mode payment{r.testModePaid === 1 ? " is" : "s are"} excluded from this period.</p> : null}
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        {CURRENCY_LIST.map((currency) => (
          <Section key={currency} title={`Revenue trend (${currency})`}>
            <TrendChart title={`Revenue trend in ${currency}`} labels={labels} format={currency} series={[{ name: `Gross ${currency}`, values: r.series[currency], color: currency === "INR" ? COLORS.indigo : COLORS.teal }]} emptyText={`No ${currency} revenue in this period.`} />
          </Section>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {(
          [
            ["By plan", r.byPlan.map((x) => ({ label: x.plan, currency: x.currency, amount: x.amount, count: x.count }))],
            ["By payment gateway", r.byGateway.map((x) => ({ label: x.gateway.charAt(0).toUpperCase() + x.gateway.slice(1), currency: x.currency, amount: x.amount, count: x.count }))],
          ] as const
        ).map(([title, rows]) => (
          <Section key={title} title={`Revenue ${title.toLowerCase()}`}>
            {rows.length === 0 ? (
              <NoRows>No verified live payments in this period.</NoRows>
            ) : (
              <table className="w-full text-left text-[0.875rem]">
                <thead>
                  <tr className="border-b border-ink-700 text-[0.75rem] text-cloud-400">
                    <th scope="col" className="py-2 pr-3 font-medium">{title.replace("By ", "").replace(/^./, (c) => c.toUpperCase())}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Currency</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Payments</th>
                    <th scope="col" className="py-2 text-right font-medium">Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.label}-${row.currency}`} className="border-b border-ink-850 last:border-0">
                      <td className="py-2 pr-3 text-cloud-100">{row.label}</td>
                      <td className="py-2 pr-3 text-cloud-300">{row.currency}</td>
                      <td className="t-data py-2 pr-3 text-right text-cloud-200">{fmtInt(row.count)}</td>
                      <td className="t-data py-2 text-right font-medium text-cloud-50">{formatMoney(row.amount, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        ))}
      </div>

      <Section
        title="Checkout abandonment and payment failures"
        description="Checkouts with saved billing details, those marked abandoned by the alert job, and failed live payments."
      >
        <dl className="mb-4 grid grid-cols-3 gap-4">
          <Stat label="Checkouts saved" value={fmtInt(r.checkouts)} />
          <Stat label="Abandoned" value={fmtInt(r.abandoned)} hint={r.checkouts ? `${fmtPct(r.abandoned / r.checkouts, 0)} of saved` : undefined} />
          <Stat label="Payments failed" value={fmtInt(r.failedCount)} />
        </dl>
        <TrendChart
          title="Checkouts and failures"
          labels={labels}
          series={[
            { name: "Checkouts saved", values: r.checkoutSeries.saved, color: COLORS.indigo },
            { name: "Abandoned", values: r.checkoutSeries.abandoned, color: COLORS.amber },
            { name: "Payments failed", values: r.failureSeries, color: COLORS.rose },
          ]}
          emptyText="No checkouts or failed payments in this period."
        />
      </Section>
    </div>
  );
}

/* ── health ─────────────────────────────────────────────────────── */

const UNAVAILABLE: { metric: string; needs: string }[] = [
  { metric: "Application errors and HTTP status codes", needs: "Request logging or an error tracker (e.g. Sentry), or Render log streams to a log service." },
  { metric: "Failed API request counts by route", needs: "The same request logging; the app does not record every API response." },
  { metric: "Uptime", needs: "An external uptime monitor (e.g. Better Stack, UptimeRobot) — the app can't observe its own downtime." },
  { metric: "Core Web Vitals", needs: "A real-user monitoring script (e.g. the web-vitals library sending to an endpoint) or Search Console." },
  { metric: "Server CPU and memory", needs: "Render's metrics dashboard or an APM agent." },
];

export function HealthTab({ query, settings }: { query: ReportQuery; settings: AnalyticsSettings }) {
  const d = healthSection(query);
  const h = d.report;
  const p = d.previous;
  const labels = d.buckets.map((b) => b.label);
  return (
    <div className="space-y-6">
      <Section title="Signals the app records" description="Only real records: payment outcomes, gateway webhooks, alert emails, scan reports and checkouts." action={<ExportLink href={exportHref(query, "health")} enabled={settings.exportEnabled} />}>
        <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Payment failures" value={fmtInt(h.paymentFailures)} hint={<ChangePill current={h.paymentFailures} previous={p.paymentFailures} format="int" lowerIsBetter />} />
          <Stat label="Rejected webhooks" value={fmtInt(h.webhookRejected)} hint={<ChangePill current={h.webhookRejected} previous={p.webhookRejected} format="int" lowerIsBetter />} definition="Webhooks refused for a bad signature or data that doesn't match an order." />
          <Stat label="Alert emails failed" value={fmtInt(h.emailFailures)} />
          <Stat label="Scan failures" value={fmtInt(h.scanFailures)} hint={<ChangePill current={h.scanFailures} previous={p.scanFailures} format="int" lowerIsBetter />} />
          <Stat label="Abandoned checkouts" value={fmtInt(h.abandonedCheckouts)} />
        </dl>
        <TrendChart
          title="Failures over time"
          labels={labels}
          series={[
            { name: "Payment failures", values: h.paymentFailureSeries, color: COLORS.rose },
            { name: "Scan failures", values: h.scanFailureSeries, color: COLORS.amber },
          ]}
          emptyText="No failures recorded in this period."
        />
      </Section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Payment failure reasons">
          <BarList rows={h.paymentFailureReasons} valueLabel="Count" empty="No failed live payments." />
        </Section>
        <Section title="Gateway webhooks">
          <BarList rows={h.webhooks} valueLabel="Count" empty="No webhooks received in this period." />
        </Section>
        <Section title="Alert email delivery">
          <BarList rows={h.emailStatus} valueLabel="Count" empty="No alert emails in this period." />
        </Section>
      </div>

      <Section title="Recent error events" description="Newest first. Details are the app's own short messages — no keys, tokens, cookies or customer contact details.">
        {h.recent.length === 0 ? (
          <NoRows>Nothing went wrong in this period, as far as the app records.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>When</Th>
                <Th>Service</Th>
                <Th>Event</Th>
                <Th>Detail</Th>
              </>
            }
          >
            {h.recent.map((e, i) => (
              <Tr key={`${e.at}-${i}`}>
                <Td mono>{fmtDateIn(e.at, query.range.tz, true)}</Td>
                <Td>{e.service}</Td>
                <Td>{e.what}</Td>
                <Td className="max-w-md text-[0.8125rem] text-cloud-300">{e.detail || "—"}</Td>
              </Tr>
            ))}
          </TableShell>
        )}
      </Section>

      <Section title="Not measured" description="These need a monitoring source the app doesn't have. Nothing here is estimated.">
        <ul className="divide-y divide-ink-850">
          {UNAVAILABLE.map((u) => (
            <li key={u.metric} className="flex gap-3 py-2.5 text-[0.875rem]">
              <XCircle className="mt-0.5 size-4 shrink-0 text-cloud-400" aria-hidden />
              <div>
                <p className="font-medium text-cloud-100">{u.metric}</p>
                <p className="text-[0.8125rem] text-cloud-400">Needs: {u.needs}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
