import { businessSeries, businessTotals, type MoneyByCurrency } from "./business";
import { ratio, type ReportScope, type Window } from "./common";
import type { AnalyticsSettings } from "./settings";
import { trackingStartedAt } from "./store";
import { sessionsWith, trafficSeries, trafficTotals } from "./traffic";
import { buckets, resolveRange, type Bucket, type Interval, type ResolvedRange } from "./time";

/**
 * Turning a dashboard URL into a report, and the overview KPIs.
 * Shared by the admin page, the JSON API and the CSV export, so all
 * three always agree.
 */

export const TABS = ["overview", "traffic", "funnel", "accounts", "scans", "revenue", "health"] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  traffic: "Traffic",
  funnel: "Funnel",
  accounts: "Accounts",
  scans: "Scans",
  revenue: "Revenue",
  health: "Website health",
};

export type ReportQuery = {
  tab: Tab;
  range: ResolvedRange;
  interval: Interval;
  includeInternal: boolean;
  /** Echo of the URL inputs, for building links. */
  params: { range: string; from?: string; to?: string; interval: Interval; internal: boolean };
  pagesPage: number;
  pagesSort: "views" | "sessions" | "path";
  usersPage: number;
  /** Set when a custom range was invalid and the default was used instead. */
  rangeError: string | null;
};

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseReportQuery(params: Params, settings: AnalyticsSettings, now = Date.now()): ReportQuery {
  const tabRaw = first(params.tab);
  const tab = (TABS as readonly string[]).includes(tabRaw ?? "") ? (tabRaw as Tab) : "overview";
  const preset = first(params.range) ?? settings.defaultRange;
  let rangeError: string | null = null;
  let range = resolveRange({ preset, from: first(params.from), to: first(params.to), tz: settings.timezone, now, fallback: settings.defaultRange });
  if ("error" in range) {
    rangeError = range.error;
    range = resolveRange({ preset: settings.defaultRange, tz: settings.timezone, now }) as ResolvedRange;
  }
  const intervalRaw = first(params.interval);
  const interval: Interval =
    intervalRaw === "week" || intervalRaw === "month" || intervalRaw === "day"
      ? intervalRaw
      : range.days > 120
        ? "week"
        : "day";
  const int = (raw: string | undefined) => {
    const n = Number.parseInt(raw ?? "", 10);
    return Number.isInteger(n) && n > 0 && n < 100_000 ? n : 1;
  };
  const sortRaw = first(params.sort);
  return {
    tab,
    range,
    interval,
    includeInternal: first(params.internal) === "1",
    params: {
      range: range.preset,
      from: range.preset === "custom" ? first(params.from) : undefined,
      to: range.preset === "custom" ? first(params.to) : undefined,
      interval,
      internal: first(params.internal) === "1",
    },
    pagesPage: int(first(params.pp)),
    pagesSort: sortRaw === "sessions" || sortRaw === "path" ? sortRaw : "views",
    usersPage: int(first(params.up)),
    rangeError,
  };
}

export function scopeOf(query: ReportQuery, previous = false): ReportScope {
  const w = previous ? query.range.previous : query.range;
  return { start: w.start, end: w.end, includeInternal: query.includeInternal };
}

export function bucketsOf(query: ReportQuery): Bucket[] {
  return buckets(query.range, query.interval);
}

/* ── coverage of tracked data ───────────────────────────────────── */

export type Coverage = {
  trackingStartedAt: number | null;
  /** none: no tracked data in the period; partial: tracking began inside it; full. */
  state: "none" | "partial" | "full";
  /** The part of the period that has tracked data. */
  tracked: Window | null;
};

export function coverageFor(window: Window, startedAt = trackingStartedAt()): Coverage {
  if (startedAt === null || startedAt >= window.end) return { trackingStartedAt: startedAt, state: "none", tracked: null };
  if (startedAt > window.start) return { trackingStartedAt: startedAt, state: "partial", tracked: { start: startedAt, end: window.end } };
  return { trackingStartedAt: startedAt, state: "full", tracked: { start: window.start, end: window.end } };
}

/* ── overview ───────────────────────────────────────────────────── */

export type KpiFormat = "int" | "pct" | "duration" | "decimal";

export type Kpi = {
  key: string;
  label: string;
  definition: string;
  source: "tracked" | "records";
  format: KpiFormat;
  value: number | null;
  previous: number | null;
  /** Lower is better (bounce rate, failure rate): colours the change the other way. */
  lowerIsBetter?: boolean;
  /** Shown instead of a value when the figure cannot be measured. */
  unavailable?: string;
  /** A short secondary line. */
  note?: string;
  /** A second figure shown beside the value (returning visitors). */
  secondary?: number;
};

export type Overview = {
  kpis: Kpi[];
  revenue: { current: MoneyByCurrency; previous: MoneyByCurrency };
  coverage: Coverage;
  previousCoverage: Coverage;
  series: {
    buckets: Bucket[];
    visitors: number[];
    sessions: number[];
    pageViews: number[];
    signups: number[];
    scans: number[];
    purchases: number[];
  };
};

function conversion(scope: ReportScope, coverage: Coverage, signupsIn: (w: Window) => number): { value: number | null; visitors: number } {
  if (!coverage.tracked) return { value: null, visitors: 0 };
  const visitors = trafficTotals({ ...coverage.tracked, includeInternal: scope.includeInternal }).visitors;
  return { value: ratio(signupsIn(coverage.tracked), visitors), visitors };
}

export function overview(query: ReportQuery): Overview {
  const now = scopeOf(query);
  const prev = scopeOf(query, true);
  const startedAt = trackingStartedAt();
  const coverage = coverageFor(now, startedAt);
  const previousCoverage = coverageFor(prev, startedAt);

  const t = trafficTotals(now);
  const tp = trafficTotals(prev);
  const b = businessTotals(now);
  const bp = businessTotals(prev);
  const checkout = sessionsWith(now, "checkout_started");
  const checkoutPrev = sessionsWith(prev, "checkout_started");
  const signupsIn = (w: Window) => businessTotals(w).signups;
  const conv = conversion(now, coverage, signupsIn);
  const convPrev = conversion(prev, previousCoverage, signupsIn);

  const tracked = (value: number | null, previous: number | null) => ({
    value: coverage.state === "none" ? null : value,
    previous: previousCoverage.state === "none" ? null : previous,
    unavailable: coverage.state === "none" ? "No tracked visits in this period" : undefined,
  });

  const kpis: Kpi[] = [
    {
      key: "visitors",
      label: "Visitors",
      definition:
        "Estimated unique visitors. Without consent to remember a browser, a visitor is recognised for one UTC day only, so someone who returns on another day is counted again in longer ranges.",
      source: "tracked",
      format: "int",
      ...tracked(t.visitors, tp.visitors),
    },
    { key: "sessions", label: "Visits", definition: "Sessions: page views and events from one browser with no gap longer than 30 minutes.", source: "tracked", format: "int", ...tracked(t.sessions, tp.sessions) },
    { key: "pageViews", label: "Page views", definition: "Every tracked page load or in-app navigation, admin pages excluded.", source: "tracked", format: "int", ...tracked(t.pageViews, tp.pageViews) },
    { key: "pagesPerSession", label: "Pages per visit", definition: "Page views ÷ visits.", source: "tracked", format: "decimal", ...tracked(t.pagesPerSession, tp.pagesPerSession) },
    {
      key: "avgDuration",
      label: "Avg. visit duration",
      definition:
        "Time from a visit's first to last recorded event. Time spent on the last page can't be measured, so one-page visits count as 0 seconds and the true figure is higher.",
      source: "tracked",
      format: "duration",
      ...tracked(t.avgDurationMs, tp.avgDurationMs),
    },
    {
      key: "bounceRate",
      label: "Bounce rate",
      definition: "Share of visits with at most one page view and no other interaction (plan click, checkout, sign-up, login, scan or payment).",
      source: "tracked",
      format: "pct",
      lowerIsBetter: true,
      ...tracked(t.bounceRate, tp.bounceRate),
    },
    {
      key: "newVisitors",
      label: "New vs returning",
      definition:
        "Only browsers whose visitors agreed to be remembered can be classified. New: first visit falls in this period. Returning: visited before it began.",
      source: "tracked",
      format: "int",
      value: t.rememberedVisitors ? t.newVisitors : null,
      previous: tp.rememberedVisitors ? tp.newVisitors : null,
      unavailable: t.rememberedVisitors ? undefined : "Needs “ask to remember” mode and visitor consent",
      secondary: t.returningVisitors,
      note: t.rememberedVisitors ? `${t.returningVisitors} returning of ${t.rememberedVisitors} remembered` : undefined,
    },
    { key: "signups", label: "Sign-ups", definition: "New accounts created (an account exists only after its email code is confirmed). Administrator accounts excluded.", source: "records", format: "int", value: b.signups, previous: bp.signups },
    {
      key: "verified",
      label: "Verified accounts",
      definition: "Accounts whose email was verified in this period. Accounts created before verification existed have no recorded date and are not counted.",
      source: "records",
      format: "int",
      value: b.verified,
      previous: bp.verified,
    },
    {
      key: "checkoutStarts",
      label: "Checkout starts",
      definition: "Visits in which the checkout form was shown (one per plan per visit). Saved billing details, from records, are shown underneath.",
      source: "tracked",
      format: "int",
      ...tracked(checkout, checkoutPrev),
      note: `${b.checkoutDetailsSaved} saved billing details`,
    },
    { key: "purchases", label: "Successful purchases", definition: "Payments the server verified with the gateway, live mode only. Pending, failed and test payments are never counted.", source: "records", format: "int", value: b.purchases, previous: bp.purchases },
    { key: "scansStarted", label: "Scans started", definition: "Scans that were charged and started (one report each). Requests refused before charging are not scans.", source: "records", format: "int", value: b.scansStarted, previous: bp.scansStarted },
    { key: "scansCompleted", label: "Scans completed", definition: "Scans that finished with a report.", source: "records", format: "int", value: b.scansCompleted, previous: bp.scansCompleted },
    {
      key: "scanFailureRate",
      label: "Scan failure rate",
      definition: "Failed ÷ (completed + failed) scans started in the period. Scans still running are left out.",
      source: "records",
      format: "pct",
      lowerIsBetter: true,
      value: b.scanFailureRate,
      previous: bp.scanFailureRate,
    },
    {
      key: "conversion",
      label: "Visitor → sign-up",
      definition: "Sign-ups ÷ visitors, both counted only over the part of the period with tracked visits.",
      source: "tracked",
      format: "pct",
      value: conv.value,
      previous: convPrev.value,
      unavailable: coverage.state === "none" ? "No tracked visits in this period" : undefined,
    },
  ];

  const list = bucketsOf(query);
  const ts = trafficSeries(now, list);
  const bs = businessSeries(list);
  return {
    kpis,
    revenue: { current: b.revenue, previous: bp.revenue },
    coverage,
    previousCoverage,
    series: { buckets: list, ...ts, ...bs },
  };
}

/** Query string for a dashboard link, keeping the range and filters. */
export function reportHref(query: ReportQuery, overrides: Record<string, string | number | null> = {}, base = "/admin/analytics"): string {
  const p = new URLSearchParams();
  p.set("tab", query.tab);
  p.set("range", query.params.range);
  if (query.params.from) p.set("from", query.params.from);
  if (query.params.to) p.set("to", query.params.to);
  p.set("interval", query.params.interval);
  if (query.params.internal) p.set("internal", "1");
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) p.delete(key);
    else p.set(key, String(value));
  }
  return `${base}?${p.toString()}`;
}
