import { many } from "@/lib/db";
import { clampPage, perBucket, ratio, scalar, type Page, type Ranked, type ReportScope } from "./common";
import type { Bucket } from "./time";

/**
 * Visitor and visit figures, from first-party tracking only. None of
 * these exist for days before tracking began; callers say so.
 *
 * Definitions (also shown as tooltips on the dashboard):
 *   visit (session)   events from one browser with no gap over 30 minutes.
 *   visitor           distinct visitor keys. In cookie-free mode a key
 *                     lasts one UTC day, so someone who comes on three
 *                     days counts up to three times in a longer range.
 *   duration          last event − first event of a visit. Time on the
 *                     final page is unknown, so one-page visits are 0 s.
 *   bounce            a visit with at most one page view and no other
 *                     interaction (plan click, checkout, sign-up, login,
 *                     scan or payment).
 */

const NOT_INTERNAL = "AND internal = 0";
const T_NOT_INTERNAL = "AND t.internal = 0";

function f(scope: ReportScope) {
  return scope.includeInternal ? "" : NOT_INTERNAL;
}
function tf(scope: ReportScope) {
  return scope.includeInternal ? "" : T_NOT_INTERNAL;
}

export type TrafficTotals = {
  visitors: number;
  sessions: number;
  pageViews: number;
  pagesPerSession: number | null;
  avgDurationMs: number | null;
  bounceRate: number | null;
  /** Visitors whose browser is remembered (consent given). */
  rememberedVisitors: number;
  newVisitors: number;
  returningVisitors: number;
};

export function trafficTotals(scope: ReportScope): TrafficTotals {
  const p = [scope.start, scope.end];
  const s = many<{ sessions: number; visitors: number; dur: number | null; bounces: number | null }>(
    `SELECT COUNT(*) AS sessions,
            COUNT(DISTINCT visitor_key) AS visitors,
            AVG(last_seen_at - started_at) AS dur,
            SUM(CASE WHEN page_views <= 1 AND interactions = 0 THEN 1 ELSE 0 END) AS bounces
       FROM analytics_sessions
      WHERE started_at >= ? AND started_at < ? ${f(scope)}`,
    p,
  )[0];
  const pageViews = scalar(
    `SELECT COUNT(*) AS n FROM analytics_events
      WHERE name = 'page_view' AND occurred_at >= ? AND occurred_at < ? ${f(scope)}`,
    p,
  );
  const remembered = scalar(
    `SELECT COUNT(DISTINCT visitor_key) AS n FROM analytics_sessions
      WHERE visitor_persistent = 1 AND started_at >= ? AND started_at < ? ${f(scope)}`,
    p,
  );
  const returning = remembered
    ? scalar(
        `SELECT COUNT(*) AS n FROM (
            SELECT DISTINCT visitor_key FROM analytics_sessions
             WHERE visitor_persistent = 1 AND started_at >= ? AND started_at < ? ${f(scope)}
          ) v
          WHERE EXISTS (SELECT 1 FROM analytics_sessions o WHERE o.visitor_key = v.visitor_key AND o.started_at < ?)`,
        [scope.start, scope.end, scope.start],
      )
    : 0;
  const sessions = Number(s?.sessions ?? 0);
  return {
    visitors: Number(s?.visitors ?? 0),
    sessions,
    pageViews,
    pagesPerSession: ratio(pageViews, sessions),
    avgDurationMs: sessions ? Number(s?.dur ?? 0) : null,
    bounceRate: ratio(Number(s?.bounces ?? 0), sessions),
    rememberedVisitors: remembered,
    newVisitors: remembered - returning,
    returningVisitors: returning,
  };
}

export type TrafficSeries = { visitors: number[]; sessions: number[]; pageViews: number[] };

export function trafficSeries(scope: ReportScope, list: Bucket[]): TrafficSeries {
  return {
    visitors: perBucket({ list, from: "analytics_sessions t", ts: "t.started_at", agg: "COUNT(DISTINCT t.visitor_key)", where: `1 = 1 ${tf(scope)}` }),
    sessions: perBucket({ list, from: "analytics_sessions t", ts: "t.started_at", agg: "COUNT(t.id)", where: `1 = 1 ${tf(scope)}` }),
    pageViews: perBucket({ list, from: "analytics_events t", ts: "t.occurred_at", agg: "COUNT(t.id)", where: `t.name = 'page_view' ${tf(scope)}` }),
  };
}

export type PageSort = "views" | "sessions" | "path";

export type PageRow = { path: string; views: number; sessions: number; landings: number; exits: number; exitRate: number | null };

/** Every tracked page, with views, landings and exits. Paginated and sortable. */
export function pagesTable(scope: ReportScope, options: { page?: unknown; sort?: PageSort; pageSize?: number }): Page<PageRow> {
  const pageSize = options.pageSize ?? 15;
  const p = [scope.start, scope.end];
  const total = scalar(
    `SELECT COUNT(DISTINCT path) AS n FROM analytics_events
      WHERE name = 'page_view' AND occurred_at >= ? AND occurred_at < ? ${f(scope)}`,
    p,
  );
  const page = clampPage(options.page, pageSize, total);
  const order = options.sort === "path" ? "v.path ASC" : options.sort === "sessions" ? "v.sessions DESC, v.views DESC" : "v.views DESC, v.sessions DESC";
  const rows = many<{ path: string; views: number; sessions: number; landings: number | null; exits: number | null }>(
    `WITH v AS (
        SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions
          FROM analytics_events
         WHERE name = 'page_view' AND occurred_at >= ? AND occurred_at < ? ${f(scope)}
         GROUP BY path
      ),
      s AS (
        SELECT landing_path, exit_path FROM analytics_sessions
         WHERE started_at >= ? AND started_at < ? ${f(scope)}
      )
      SELECT v.path, v.views, v.sessions,
             (SELECT COUNT(*) FROM s WHERE s.landing_path = v.path) AS landings,
             (SELECT COUNT(*) FROM s WHERE s.exit_path = v.path) AS exits
        FROM v
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    [...p, ...p, pageSize, (page - 1) * pageSize],
  );
  return {
    rows: rows.map((r) => ({
      path: r.path,
      views: Number(r.views),
      sessions: Number(r.sessions),
      landings: Number(r.landings ?? 0),
      exits: Number(r.exits ?? 0),
      exitRate: ratio(Number(r.exits ?? 0), Number(r.sessions)),
    })),
    total,
    page,
    pageSize,
  };
}

function grouped(scope: ReportScope, column: string, limit: number, extraWhere = ""): Ranked[] {
  return many<{ label: string | null; n: number; visitors: number }>(
    `SELECT ${column} AS label, COUNT(*) AS n, COUNT(DISTINCT visitor_key) AS visitors
       FROM analytics_sessions
      WHERE started_at >= ? AND started_at < ? ${f(scope)} ${extraWhere}
      GROUP BY ${column}
      ORDER BY n DESC
      LIMIT ?`,
    [scope.start, scope.end, limit],
  ).map((r) => ({ label: r.label ?? "Unknown", value: Number(r.n), secondary: Number(r.visitors) }));
}

/** Landing pages by visits started there, with that page's bounce rate. */
export function landingPages(scope: ReportScope, limit = 10): Ranked[] {
  return many<{ label: string; n: number; bounces: number }>(
    `SELECT landing_path AS label, COUNT(*) AS n,
            SUM(CASE WHEN page_views <= 1 AND interactions = 0 THEN 1 ELSE 0 END) AS bounces
       FROM analytics_sessions
      WHERE started_at >= ? AND started_at < ? ${f(scope)} AND landing_path IS NOT NULL
      GROUP BY landing_path ORDER BY n DESC LIMIT ?`,
    [scope.start, scope.end, limit],
  ).map((r) => ({ label: r.label, value: Number(r.n), secondary: ratio(Number(r.bounces), Number(r.n)) }));
}

export function exitPages(scope: ReportScope, limit = 10): Ranked[] {
  return grouped(scope, "exit_path", limit, "AND exit_path IS NOT NULL");
}

export const SOURCE_LABEL: Record<string, string> = {
  direct: "Direct / unknown",
  search: "Search engines",
  social: "Social media",
  email: "Email",
  paid: "Paid campaigns",
  referral: "Other websites",
};

export function sourceTypes(scope: ReportScope): Ranked[] {
  return grouped(scope, "referrer_type", 10).map((r) => ({ ...r, label: SOURCE_LABEL[r.label] ?? r.label }));
}

export function referrerHosts(scope: ReportScope, limit = 10): Ranked[] {
  return grouped(scope, "referrer_host", limit, "AND referrer_host IS NOT NULL");
}

export function deviceSplit(scope: ReportScope): Ranked[] {
  return grouped(scope, "device", 5);
}
export function browserSplit(scope: ReportScope): Ranked[] {
  return grouped(scope, "browser", 8);
}
export function osSplit(scope: ReportScope): Ranked[] {
  return grouped(scope, "os", 8);
}
export function countrySplit(scope: ReportScope): Ranked[] {
  return grouped(scope, "country", 10, "AND country IS NOT NULL");
}

export type CampaignRow = {
  source: string;
  medium: string;
  campaign: string;
  sessions: number;
  visitors: number;
  signups: number;
  purchases: number;
};

/**
 * Visits that arrived with UTM tags, and how many of those visits led to
 * an account being created or a verified live payment in the same visit
 * (server events attached to the visit, so the browser cannot fake them).
 */
export function campaigns(scope: ReportScope, limit = 20): CampaignRow[] {
  return many<{ source: string | null; medium: string | null; campaign: string | null; sessions: number; visitors: number; signups: number; purchases: number }>(
    `SELECT s.utm_source AS source, s.utm_medium AS medium, s.utm_campaign AS campaign,
            COUNT(*) AS sessions, COUNT(DISTINCT s.visitor_key) AS visitors,
            SUM(EXISTS (SELECT 1 FROM analytics_events e WHERE e.session_id = s.id AND e.name = 'email_verified')) AS signups,
            SUM(EXISTS (SELECT 1 FROM analytics_events e WHERE e.session_id = s.id AND e.name = 'payment_succeeded'
                         AND json_extract(e.props_json, '$.mode') = 'live')) AS purchases
       FROM analytics_sessions s
      WHERE s.started_at >= ? AND s.started_at < ? ${scope.includeInternal ? "" : "AND s.internal = 0"}
        AND (s.utm_source IS NOT NULL OR s.utm_medium IS NOT NULL OR s.utm_campaign IS NOT NULL)
      GROUP BY s.utm_source, s.utm_medium, s.utm_campaign
      ORDER BY sessions DESC
      LIMIT ?`,
    [scope.start, scope.end, limit],
  ).map((r) => ({
    source: r.source ?? "(not set)",
    medium: r.medium ?? "(not set)",
    campaign: r.campaign ?? "(not set)",
    sessions: Number(r.sessions),
    visitors: Number(r.visitors),
    signups: Number(r.signups ?? 0),
    purchases: Number(r.purchases ?? 0),
  }));
}

/** Distinct visits in which a given browser/server event happened. */
export function sessionsWith(scope: ReportScope, name: string): number {
  return scalar(
    `SELECT COUNT(DISTINCT session_id) AS n FROM analytics_events
      WHERE name = ? AND session_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ? ${f(scope)}`,
    [name, scope.start, scope.end],
  );
}

export function eventCount(scope: ReportScope, name: string): number {
  return scalar(
    `SELECT COUNT(*) AS n FROM analytics_events WHERE name = ? AND occurred_at >= ? AND occurred_at < ? ${f(scope)}`,
    [name, scope.start, scope.end],
  );
}

export function internalSessionCount(scope: ReportScope): number {
  return scalar("SELECT COUNT(*) AS n FROM analytics_sessions WHERE internal = 1 AND started_at >= ? AND started_at < ?", [scope.start, scope.end]);
}
