import { Suspense } from "react";
import Link from "next/link";
import { Settings } from "lucide-react";

import { AccountsTab, FunnelTab, HealthTab, RevenueTab, ScansTab } from "@/components/admin/analytics/BusinessTabs";
import { Notice } from "@/components/admin/analytics/Parts";
import { RangeControls } from "@/components/admin/analytics/RangeControls";
import { AnalyticsSkeleton } from "@/components/admin/analytics/Skeleton";
import { TabErrorBoundary } from "@/components/admin/analytics/TabErrorBoundary";
import { OverviewTab, TrafficTab } from "@/components/admin/analytics/TrafficTabs";
import { fmtDateIn } from "@/components/admin/analytics/format";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { ButtonLink } from "@/components/ui/Button";
import { requireAdmin } from "@/lib/auth/guard";
import { cn } from "@/lib/cn";
import { parseReportQuery, reportHref, TAB_LABEL, TABS, type ReportQuery, type Tab } from "@/lib/analytics/report";
import { analyticsSettings, type AnalyticsSettings } from "@/lib/analytics/settings";
import { trackingStatus } from "@/lib/analytics/store";
import { formatLocalDate, localDateOf, tzOffsetLabel } from "@/lib/analytics/time";

export const dynamic = "force-dynamic";

export const metadata = { title: "Website analytics — Admin" };

type Params = Record<string, string | string[] | undefined>;

/**
 * Website analytics. The admin layout has already required an
 * administrator; requireAdmin() runs again here because this page reads
 * account and payment data directly. Every figure is computed on the
 * server from the database — nothing is sample or placeholder data.
 */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAdmin();
  const params = await searchParams;
  const settings = analyticsSettings();
  const query = parseReportQuery(params, settings);
  const now = Date.now();
  const status = trackingStatus(now);
  const prev = query.range.previous;

  return (
    <div className="space-y-5">
      <PageHeading
        eyebrow="Administration"
        title="Website analytics"
        lede="Visits from the site's own privacy-friendly tracking, plus accounts, scans and revenue from your records."
        action={
          <ButtonLink href="/admin/analytics/settings" variant="ghost" size="sm">
            <Settings className="size-4" aria-hidden />
            Analytics settings
          </ButtonLink>
        }
      />

      {!settings.enabled ? (
        <Notice tone="warn" title="Visit tracking is switched off">
          No new visits or events are being recorded. Figures from records (accounts, scans, revenue) are unaffected.{" "}
          <Link href="/admin/analytics/settings" className="font-medium text-azure-600 underline underline-offset-2">
            Turn it on in Settings
          </Link>
          .
        </Notice>
      ) : null}
      {query.rangeError ? (
        <Notice tone="warn" title="That date range couldn't be used">
          {query.rangeError} Showing {query.range.label.toLowerCase()} instead.
        </Notice>
      ) : null}

      <div className="glass space-y-3 rounded-xl px-4 py-3.5">
        <RangeControls
          range={query.range.preset}
          from={formatLocalDate(query.range.fromDate)}
          to={formatLocalDate(query.range.toDate)}
          interval={query.interval}
          internal={query.includeInternal}
          showInternalToggle={settings.internalMode === "flag"}
          today={formatLocalDate(localDateOf(now, settings.timezone))}
        />
        <p className="text-[0.8125rem] leading-relaxed text-cloud-400">
          <span className="font-medium text-cloud-200">
            {fmtDateIn(query.range.start, query.range.tz)} – {fmtDateIn(Math.max(query.range.start, query.range.end - 1), query.range.tz)}
            {query.range.partial ? " (so far)" : ""}
          </span>{" "}
          · compared with {fmtDateIn(prev.start, query.range.tz)} – {fmtDateIn(Math.max(prev.start, prev.end - 1), query.range.tz)} · reporting timezone{" "}
          <span className="font-medium text-cloud-200">
            {query.range.tz} ({tzOffsetLabel(query.range.tz, now)})
          </span>
          {status.lastBrowserEventAt ? ` · last tracked visit ${fmtDateIn(status.lastBrowserEventAt, query.range.tz, true)}` : ""}
        </p>
      </div>

      <nav aria-label="Analytics sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1 border-b border-ink-700">
          {TABS.map((tab) => {
            const active = tab === query.tab;
            return (
              <li key={tab}>
                <Link
                  href={reportHref(query, { tab, pp: null, up: null, sort: null })}
                  aria-current={active ? "page" : undefined}
                  scroll={false}
                  className={cn(
                    "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-[0.875rem] font-medium transition-colors",
                    active ? "border-azure-500 text-azure-600" : "border-transparent text-cloud-300 hover:text-cloud-50",
                  )}
                >
                  {TAB_LABEL[tab]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <TabErrorBoundary key={JSON.stringify(query.params) + query.tab + query.pagesPage + query.pagesSort + query.usersPage}>
        <Suspense fallback={<AnalyticsSkeleton />}>
          <TabContent tab={query.tab} query={query} settings={settings} />
        </Suspense>
      </TabErrorBoundary>
    </div>
  );
}

async function TabContent({ tab, query, settings }: { tab: Tab; query: ReportQuery; settings: AnalyticsSettings }) {
  // Yield once so the skeleton can stream before the queries run.
  await Promise.resolve();
  switch (tab) {
    case "overview":
      return <OverviewTab query={query} settings={settings} />;
    case "traffic":
      return <TrafficTab query={query} settings={settings} />;
    case "funnel":
      return <FunnelTab query={query} settings={settings} />;
    case "accounts":
      return <AccountsTab query={query} settings={settings} />;
    case "scans":
      return <ScansTab query={query} settings={settings} />;
    case "revenue":
      return <RevenueTab query={query} settings={settings} />;
    case "health":
      return <HealthTab query={query} settings={settings} />;
  }
}
