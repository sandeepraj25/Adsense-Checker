import Link from "next/link";

import { NoRows, TableShell, Td, Th, Tr } from "@/components/admin/Panels";
import { formatMoney } from "@/lib/money";
import type { Coverage, ReportQuery } from "@/lib/analytics/report";
import { overview, reportHref } from "@/lib/analytics/report";
import { trafficSection } from "@/lib/analytics/sections";
import type { AnalyticsSettings } from "@/lib/analytics/settings";
import { TrendChart } from "./Charts";
import { fmtDateIn, fmtDuration, fmtInt, fmtPct } from "./format";
import { BarList, ChangePill, Definition, ExportLink, KpiCard, Notice, Pager, Section, Stat } from "./Parts";

export const COLORS = { indigo: "#4f46e5", teal: "#0f766e", amber: "#b45309", rose: "#be123c", slate: "#64748b" };

export function exportHref(query: ReportQuery, dataset: string): string {
  return reportHref(query, { dataset, tab: null, pp: null, up: null, sort: null }, "/api/admin/analytics/export");
}

export function CoverageNotice({ coverage, settings }: { coverage: Coverage; settings: AnalyticsSettings }) {
  if (coverage.state === "full") return null;
  if (coverage.state === "none") {
    return (
      <Notice tone="info" title={coverage.trackingStartedAt ? "No tracked visits in this period" : "Visitor tracking hasn't recorded anything yet"}>
        {coverage.trackingStartedAt
          ? `Tracked visit data starts on ${fmtDateIn(coverage.trackingStartedAt, settings.timezone)}. Visitor, visit, page and funnel figures need that data; accounts, scans and revenue below come from records and are complete.`
          : settings.enabled
            ? "Visitor figures appear once people browse the public site (admins and bots are not counted). Accounts, scans and revenue come from existing records and include history."
            : "Tracking is switched off in Settings. Accounts, scans and revenue still come from existing records."}
      </Notice>
    );
  }
  return (
    <Notice tone="info" title={`Visitor data starts on ${fmtDateIn(coverage.trackingStartedAt as number, settings.timezone)}`}>
      This period begins before tracking did, so visitor, visit and funnel figures cover only part of it. Earlier days are not estimated. Accounts, scans and revenue come
      from records and cover the whole period.
    </Notice>
  );
}

/* ── overview ───────────────────────────────────────────────────── */

export function OverviewTab({ query, settings }: { query: ReportQuery; settings: AnalyticsSettings }) {
  const data = overview(query);
  const tracked = data.kpis.filter((k) => k.source === "tracked" && k.key !== "conversion");
  const business = data.kpis.filter((k) => !tracked.includes(k));
  const afterPurchases = business.findIndex((k) => k.key === "purchases") + 1;
  const labels = data.series.buckets.map((b) => b.label);

  return (
    <div className="space-y-6">
      <CoverageNotice coverage={data.coverage} settings={settings} />

      <section aria-labelledby="kpi-traffic" className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <h2 id="kpi-traffic" className="text-[0.9375rem] font-semibold text-cloud-50">
            Visitors and engagement
          </h2>
          <ExportLink href={exportHref(query, "overview")} enabled={settings.exportEnabled} label="Export KPIs" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {tracked.map(({ key, ...k }) =>
            key === "newVisitors" && k.value !== null ? (
              <KpiCard key={key} {...k} note={undefined}>
                <p className="t-data mt-1.5 text-[1.375rem] leading-none font-semibold tracking-tight text-cloud-50">
                  {fmtInt(k.value)} <span className="text-[0.875rem] font-medium text-cloud-400">new</span> · {fmtInt(k.secondary ?? 0)}{" "}
                  <span className="text-[0.875rem] font-medium text-cloud-400">returning</span>
                </p>
                <p className="mt-2 text-[0.75rem] text-cloud-400">Of browsers whose visitors agreed to be remembered.</p>
              </KpiCard>
            ) : (
              <KpiCard key={key} {...k} />
            ),
          )}
        </div>
      </section>

      <section aria-labelledby="kpi-business" className="space-y-2.5">
        <h2 id="kpi-business" className="text-[0.9375rem] font-semibold text-cloud-50">
          Accounts, scans and revenue
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {business.slice(0, afterPurchases).map(({ key, ...k }) => (
            <KpiCard key={key} {...k} />
          ))}
          <KpiCard
            label="Revenue"
            definition="Verified live payments, by the time the gateway confirmed them. Each currency is shown on its own — rupees and dollars are never added together. Refunds are not recorded by this app."
            value={null}
            previous={null}
            format="int"
            source="records"
          >
            <div className="mt-1.5 space-y-1.5">
              {(["INR", "USD"] as const).map((currency) => (
                <div key={currency} className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                  <span className="t-data text-[1.125rem] font-semibold text-cloud-50">{formatMoney(data.revenue.current[currency], currency)}</span>
                  <ChangePill current={data.revenue.current[currency]} previous={data.revenue.previous[currency]} format="int" />
                </div>
              ))}
            </div>
          </KpiCard>
          {business.slice(afterPurchases).map(({ key, ...k }) => (
            <KpiCard key={key} {...k} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Traffic trend" description="Tracked visitors, visits and page views." action={<ExportLink href={exportHref(query, "timeseries")} enabled={settings.exportEnabled} />}>
          <TrendChart
            title="Traffic trend"
            labels={labels}
            series={[
              { name: "Visitors", values: data.series.visitors, color: COLORS.indigo },
              { name: "Visits", values: data.series.sessions, color: COLORS.teal },
              { name: "Page views", values: data.series.pageViews, color: COLORS.slate },
            ]}
            emptyText="No tracked visits in this period."
          />
        </Section>
        <Section title="Business trend" description="From records: new accounts, scans started and verified live purchases.">
          <TrendChart
            title="Business trend"
            labels={labels}
            series={[
              { name: "Sign-ups", values: data.series.signups, color: COLORS.indigo },
              { name: "Scans started", values: data.series.scans, color: COLORS.teal },
              { name: "Purchases", values: data.series.purchases, color: COLORS.amber },
            ]}
            emptyText="No sign-ups, scans or purchases in this period."
          />
        </Section>
      </div>
    </div>
  );
}

/* ── traffic ────────────────────────────────────────────────────── */

export function TrafficTab({ query, settings }: { query: ReportQuery; settings: AnalyticsSettings }) {
  const d = trafficSection(query);
  const t = d.totals;
  const p = d.previous;
  const sortLink = (sort: string) => reportHref(query, { sort, pp: 1 });

  return (
    <div className="space-y-6">
      <CoverageNotice coverage={d.coverage} settings={settings} />

      <Section title="Visitors, visits and page views" action={<ExportLink href={exportHref(query, "timeseries")} enabled={settings.exportEnabled} />}>
        <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Visitors" value={fmtInt(t.visitors)} hint={<ChangePill current={t.visitors} previous={p.visitors} format="int" />} definition="Estimated unique visitors (see Overview for how they're counted)." />
          <Stat label="Visits" value={fmtInt(t.sessions)} hint={<ChangePill current={t.sessions} previous={p.sessions} format="int" />} />
          <Stat label="Page views" value={fmtInt(t.pageViews)} hint={<ChangePill current={t.pageViews} previous={p.pageViews} format="int" />} />
          <Stat label="Pages per visit" value={t.pagesPerSession === null ? "—" : t.pagesPerSession.toFixed(2)} />
          <Stat label="Avg. duration" value={fmtDuration(t.avgDurationMs)} definition="First to last event of a visit. The last page's time is unknown, so this understates real time on site." />
          <Stat label="Bounce rate" value={fmtPct(t.bounceRate)} hint={<ChangePill current={t.bounceRate} previous={p.bounceRate} format="pct" lowerIsBetter />} definition="Visits with at most one page view and no other interaction." />
        </dl>
        <TrendChart
          title="Visitors, visits and page views"
          labels={d.buckets.map((b) => b.label)}
          series={[
            { name: "Visitors", values: d.series.visitors, color: COLORS.indigo },
            { name: "Visits", values: d.series.sessions, color: COLORS.teal },
            { name: "Page views", values: d.series.pageViews, color: COLORS.slate },
          ]}
          emptyText="No tracked visits in this period."
        />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="New vs returning visitors"
          description="Only browsers whose visitors agreed to be remembered can be told apart; cookie-free visits can't be."
        >
          {t.rememberedVisitors ? (
            <dl className="grid grid-cols-3 gap-4">
              <Stat label="Remembered" value={fmtInt(t.rememberedVisitors)} hint={`of ${fmtInt(t.visitors)} visitors`} />
              <Stat label="New" value={fmtInt(t.newVisitors)} hint={fmtPct(t.newVisitors / t.rememberedVisitors, 0)} />
              <Stat label="Returning" value={fmtInt(t.returningVisitors)} hint={fmtPct(t.returningVisitors / t.rememberedVisitors, 0)} />
            </dl>
          ) : (
            <p className="text-[0.875rem] leading-relaxed text-cloud-400">
              {settings.consentMode === "ask"
                ? "No visitor in this period has agreed to be remembered yet."
                : "Not measured in cookie-free mode. To measure it, switch Settings → Privacy mode to “Ask visitors”; only visitors who agree are counted."}
            </p>
          )}
        </Section>
        <Section title="Traffic sources" description="From the referring site's host name, or the link's utm_medium when tagged." action={<ExportLink href={exportHref(query, "sources")} enabled={settings.exportEnabled} />}>
          <BarList rows={d.sources} valueLabel="Visits" secondaryLabel="Visitors" empty="No tracked visits." />
        </Section>
        <Section title="Top landing pages" description="Where visits started, with each page's bounce rate." action={<ExportLink href={exportHref(query, "landing")} enabled={settings.exportEnabled} />}>
          <BarList rows={d.landing} valueLabel="Visits" secondaryLabel="Bounce" secondaryFormat="pct" empty="No landing pages yet." mono />
        </Section>
        <Section title="Exit pages" description="The last page viewed in a visit." action={<ExportLink href={exportHref(query, "exits")} enabled={settings.exportEnabled} />}>
          <BarList rows={d.exits} valueLabel="Exits" secondaryLabel="Visitors" empty="No exit pages yet." mono />
        </Section>
        <Section title="Referring websites" description="Host names only; full referring URLs are never stored." action={<ExportLink href={exportHref(query, "referrers")} enabled={settings.exportEnabled} />}>
          <BarList rows={d.referrers} valueLabel="Visits" secondaryLabel="Visitors" empty="No visits came from another website in this period." />
        </Section>
        <Section title="Devices" description="From the browser's user agent — a distribution, not exact per visit." action={<ExportLink href={exportHref(query, "devices")} enabled={settings.exportEnabled} />}>
          <BarList rows={d.devices.map((r) => ({ ...r, label: r.label.charAt(0).toUpperCase() + r.label.slice(1) }))} valueLabel="Visits" secondaryLabel="Visitors" empty="No tracked visits." />
        </Section>
        <Section title="Browsers">
          <BarList rows={d.browsers} valueLabel="Visits" secondaryLabel="Visitors" empty="No tracked visits." />
        </Section>
        <Section title="Operating systems">
          <BarList rows={d.os} valueLabel="Visits" secondaryLabel="Visitors" empty="No tracked visits." />
        </Section>
      </div>

      <Section
        title="Countries"
        description="Only recorded when a trusted proxy in front of the site supplies a country header (ANALYTICS_COUNTRY_HEADER). IP addresses are not looked up or stored."
      >
        {d.countries.length ? (
          <BarList rows={d.countries} valueLabel="Visits" secondaryLabel="Visitors" empty="" />
        ) : (
          <p className="text-[0.875rem] leading-relaxed text-cloud-400">
            Not measured. Render doesn&apos;t supply a visitor country, and guessing from IP addresses would need a GeoIP database and storing addresses. If the site is
            put behind Cloudflare, set <code className="t-data">ANALYTICS_COUNTRY_HEADER=cf-ipcountry</code> to record country codes.
          </p>
        )}
      </Section>

      <Section
        title="Campaigns (UTM)"
        description="Visits that arrived with utm_source, utm_medium or utm_campaign tags. Sign-ups and purchases are server-verified and counted when they happened in the same visit."
        action={<ExportLink href={exportHref(query, "campaigns")} enabled={settings.exportEnabled} />}
      >
        {d.campaigns.length === 0 ? (
          <NoRows>No tagged visits in this period. Add ?utm_source=…&amp;utm_medium=…&amp;utm_campaign=… to links you share.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>Source</Th>
                <Th>Medium</Th>
                <Th>Campaign</Th>
                <Th className="text-right">Visits</Th>
                <Th className="text-right">Visitors</Th>
                <Th className="text-right">Sign-ups</Th>
                <Th className="text-right">Purchases</Th>
              </>
            }
          >
            {d.campaigns.map((c) => (
              <Tr key={`${c.source}|${c.medium}|${c.campaign}`}>
                <Td>{c.source}</Td>
                <Td>{c.medium}</Td>
                <Td>{c.campaign}</Td>
                <Td mono className="text-right">{fmtInt(c.sessions)}</Td>
                <Td mono className="text-right">{fmtInt(c.visitors)}</Td>
                <Td mono className="text-right">{fmtInt(c.signups)}</Td>
                <Td mono className="text-right">{fmtInt(c.purchases)}</Td>
              </Tr>
            ))}
          </TableShell>
        )}
      </Section>

      <Section
        title="Pages"
        description="Paths with record ids replaced by [id]; query strings are never stored. Exit rate = exits ÷ visits that viewed the page."
        action={<ExportLink href={exportHref(query, "pages")} enabled={settings.exportEnabled} />}
      >
        {d.pages.total === 0 ? (
          <NoRows>No tracked page views in this period.</NoRows>
        ) : (
          <>
            <TableShell
              head={
                <>
                  <Th>
                    <Link href={sortLink("path")} scroll={false} aria-current={query.pagesSort === "path" ? "true" : undefined} className="hover:text-cloud-50 aria-[current]:text-azure-600">
                      Page
                    </Link>
                  </Th>
                  <Th className="text-right">
                    <Link href={sortLink("views")} scroll={false} aria-current={query.pagesSort === "views" ? "true" : undefined} className="hover:text-cloud-50 aria-[current]:text-azure-600">
                      Views
                    </Link>
                  </Th>
                  <Th className="text-right">
                    <Link href={sortLink("sessions")} scroll={false} aria-current={query.pagesSort === "sessions" ? "true" : undefined} className="hover:text-cloud-50 aria-[current]:text-azure-600">
                      Visits
                    </Link>
                  </Th>
                  <Th className="text-right">Landings</Th>
                  <Th className="text-right">Exits</Th>
                  <Th className="text-right">Exit rate</Th>
                </>
              }
            >
              {d.pages.rows.map((r) => (
                <Tr key={r.path}>
                  <Td mono className="max-w-[22rem] truncate">{r.path}</Td>
                  <Td mono className="text-right">{fmtInt(r.views)}</Td>
                  <Td mono className="text-right">{fmtInt(r.sessions)}</Td>
                  <Td mono className="text-right">{fmtInt(r.landings)}</Td>
                  <Td mono className="text-right">{fmtInt(r.exits)}</Td>
                  <Td mono className="text-right">{fmtPct(r.exitRate, 0)}</Td>
                </Tr>
              ))}
            </TableShell>
            <Pager page={d.pages.page} total={d.pages.total} pageSize={d.pages.pageSize} href={(page) => reportHref(query, { pp: page, sort: query.pagesSort })} />
          </>
        )}
      </Section>

      <p className="flex items-center gap-1 text-[0.8125rem] text-cloud-400">
        {settings.internalMode === "flag"
          ? `${fmtInt(d.internalSessions)} internal visit${d.internalSessions === 1 ? "" : "s"} in this period ${query.includeInternal ? "are included above" : "are hidden"}.`
          : "Internal visits (signed-in admins and listed addresses) are not recorded."}
        <Definition label="Internal traffic" text="Change how internal visits are handled in Website analytics → Settings. Bots and automated clients are never recorded." />
      </p>
    </div>
  );
}
