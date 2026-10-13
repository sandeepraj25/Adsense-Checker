import { minorToDecimalString } from "@/lib/money";
import { accountsReport, healthReport, revenueReport, scansReport, usersTable } from "./business";
import { toCsv, type Cell } from "./csv";
import { accountFunnel, journeyFunnel } from "./funnel";
import { bucketsOf, overview, scopeOf, type ReportQuery } from "./report";
import type { AnalyticsSettings } from "./settings";
import { formatLocalDate, percentChange } from "./time";
import {
  browserSplit,
  campaigns,
  countrySplit,
  deviceSplit,
  exitPages,
  landingPages,
  osSplit,
  pagesTable,
  referrerHosts,
  sourceTypes,
  type PageRow,
} from "./traffic";

/**
 * Every CSV the dashboard offers. Each is built from the same functions
 * the page uses, for the same range and filters, aggregated on the
 * server; the largest (pages, accounts) are capped.
 */

export const EXPORTS = {
  overview: "KPIs, this period vs previous",
  timeseries: "Trend by day/week/month",
  pages: "All pages",
  landing: "Landing pages",
  exits: "Exit pages",
  sources: "Traffic source types",
  referrers: "Referring websites",
  campaigns: "UTM campaigns",
  devices: "Devices, browsers and operating systems",
  funnel: "Funnels",
  accounts: "Account activity by period",
  users: "Accounts table",
  scans: "Scans by period and breakdowns",
  revenue: "Revenue by period, plan and gateway",
  health: "Recent error events",
} as const;

export type ExportName = keyof typeof EXPORTS;

export function isExportName(value: unknown): value is ExportName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EXPORTS, value);
}

const MAX_ROWS = 10_000;

function pct(value: number | null): Cell {
  return value === null ? "" : (value * 100).toFixed(2);
}

function allPages(query: ReportQuery): PageRow[] {
  const out: PageRow[] = [];
  for (let page = 1; out.length < MAX_ROWS; page++) {
    const chunk = pagesTable(scopeOf(query), { page, sort: "views", pageSize: 500 });
    out.push(...chunk.rows);
    if (chunk.rows.length < 500 || page * 500 >= chunk.total) break;
  }
  return out;
}

export function buildExport(name: ExportName, query: ReportQuery, settings: AnalyticsSettings): { filename: string; csv: string } {
  const scope = scopeOf(query);
  const list = bucketsOf(query);
  const range = `${formatLocalDate(query.range.fromDate)}_${formatLocalDate(query.range.toDate)}`;
  const file = (slug: string) => `analytics-${slug}-${range}.csv`;

  switch (name) {
    case "overview": {
      const o = overview(query);
      const rows: Cell[][] = o.kpis.map((k) => [
        k.label,
        k.value ?? "",
        k.previous ?? "",
        k.value !== null && k.previous !== null ? (percentChange(k.value, k.previous)?.toFixed(2) ?? "") : "",
        k.format,
        k.source,
        k.unavailable ?? "",
      ]);
      for (const currency of ["INR", "USD"] as const) {
        rows.push([
          `Revenue (${currency})`,
          minorToDecimalString(o.revenue.current[currency]),
          minorToDecimalString(o.revenue.previous[currency]),
          percentChange(o.revenue.current[currency], o.revenue.previous[currency])?.toFixed(2) ?? "",
          "money",
          "records",
          "",
        ]);
      }
      return { filename: file("overview"), csv: toCsv(["metric", "this_period", "previous_period", "change_pct", "format", "source", "note"], rows) };
    }
    case "timeseries": {
      const o = overview(query);
      const s = o.series;
      return {
        filename: file(`trend-${query.interval}`),
        csv: toCsv(
          ["period_start", "visitors", "visits", "page_views", "signups", "scans_started", "purchases"],
          s.buckets.map((b, i) => [b.key, s.visitors[i], s.sessions[i], s.pageViews[i], s.signups[i], s.scans[i], s.purchases[i]]),
        ),
      };
    }
    case "pages":
      return {
        filename: file("pages"),
        csv: toCsv(
          ["path", "views", "visits", "landings", "exits", "exit_rate_pct"],
          allPages(query).map((r) => [r.path, r.views, r.sessions, r.landings, r.exits, pct(r.exitRate)]),
        ),
      };
    case "landing":
      return { filename: file("landing-pages"), csv: toCsv(["path", "visits", "bounce_rate_pct"], landingPages(scope, 1000).map((r) => [r.label, r.value, pct(r.secondary ?? null)])) };
    case "exits":
      return { filename: file("exit-pages"), csv: toCsv(["path", "exits", "visitors"], exitPages(scope, 1000).map((r) => [r.label, r.value, r.secondary])) };
    case "sources":
      return { filename: file("sources"), csv: toCsv(["source", "visits", "visitors"], sourceTypes(scope).map((r) => [r.label, r.value, r.secondary])) };
    case "referrers":
      return { filename: file("referrers"), csv: toCsv(["referrer_host", "visits", "visitors"], referrerHosts(scope, 1000).map((r) => [r.label, r.value, r.secondary])) };
    case "campaigns":
      return {
        filename: file("campaigns"),
        csv: toCsv(
          ["utm_source", "utm_medium", "utm_campaign", "visits", "visitors", "signups_in_visit", "purchases_in_visit"],
          campaigns(scope, 1000).map((c) => [c.source, c.medium, c.campaign, c.sessions, c.visitors, c.signups, c.purchases]),
        ),
      };
    case "devices": {
      const rows: Cell[][] = [];
      for (const [kind, data] of [
        ["device", deviceSplit(scope)],
        ["browser", browserSplit(scope)],
        ["os", osSplit(scope)],
        ["country", countrySplit(scope)],
      ] as const) {
        for (const r of data) rows.push([kind, r.label, r.value, r.secondary]);
      }
      return { filename: file("devices"), csv: toCsv(["dimension", "value", "visits", "visitors"], rows) };
    }
    case "funnel": {
      const rows: Cell[][] = [];
      for (const [label, f] of [
        ["visitor journey (tracked)", journeyFunnel(scope)],
        ["accounts (records)", accountFunnel(scope)],
      ] as const) {
        f.steps.forEach((s, i) => rows.push([label, i + 1, s.label, s.count, pct(s.fromPrevious), pct(s.fromStart), s.dropOff, pct(s.dropOffRate)]));
      }
      return { filename: file("funnel"), csv: toCsv(["funnel", "step", "label", "count", "conv_from_previous_pct", "conv_from_start_pct", "drop_off", "drop_off_pct"], rows) };
    }
    case "accounts": {
      const a = accountsReport(scope, list, Date.now());
      return {
        filename: file("accounts"),
        csv: toCsv(["period_start", "new_accounts", "active_accounts"], list.map((b, i) => [b.key, a.registrations[i], a.activeSeries[i]])),
      };
    }
    case "users": {
      const t = usersTable({ limit: MAX_ROWS });
      const header = ["account_id", "name", ...(settings.exportIncludesEmail ? ["email"] : []), "registered_utc", "email_verified_utc", "last_activity_utc", "plan", "subscription_status", "account_status", "scans"];
      const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "");
      return {
        filename: `analytics-accounts-${formatLocalDate(query.range.toDate)}.csv`,
        csv: toCsv(
          header,
          t.rows.map((r) => [r.id, r.name, ...(settings.exportIncludesEmail ? [r.email] : []), iso(r.createdAt), iso(r.verifiedAt), iso(r.lastActivityAt), r.planName, r.subscriptionStatus, r.accountStatus, r.scans]),
        ),
      };
    }
    case "scans": {
      const s = scansReport(scope, list);
      const rows: Cell[][] = list.map((b, i) => ["period", b.key, s.series.started[i], s.series.completed[i], s.series.failed[i]]);
      for (const [kind, data] of [
        ["verdict", s.verdicts],
        ["score_band", s.scoreBands],
        ["plan", s.byPlan],
        ["free_vs_paid", s.freeVsPaid],
        ["failure_reason", s.failureReasons],
        ["limit_reached", s.blocked],
      ] as const) {
        for (const r of data) rows.push([kind, r.label, r.value, "", ""]);
      }
      return { filename: file("scans"), csv: toCsv(["row_type", "label", "started_or_count", "completed", "failed"], rows) };
    }
    case "revenue": {
      const r = revenueReport(scope, list);
      const rows: Cell[][] = [];
      list.forEach((b, i) => {
        rows.push(["period", b.key, "INR", minorToDecimalString(r.series.INR[i]), ""]);
        rows.push(["period", b.key, "USD", minorToDecimalString(r.series.USD[i]), ""]);
      });
      for (const p of r.byPlan) rows.push(["plan", p.plan, p.currency, minorToDecimalString(p.amount), p.count]);
      for (const g of r.byGateway) rows.push(["gateway", g.gateway, g.currency, minorToDecimalString(g.amount), g.count]);
      return { filename: file("revenue"), csv: toCsv(["row_type", "label", "currency", "gross_amount", "payments"], rows) };
    }
    case "health": {
      const h = healthReport(scope, list);
      return { filename: file("health"), csv: toCsv(["time_utc", "service", "event", "detail"], h.recent.map((e) => [new Date(e.at).toISOString(), e.service, e.what, e.detail])) };
    }
  }
}
