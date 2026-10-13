import { accountsReport, cohorts, healthReport, revenueReport, scansReport, usersTable } from "./business";
import { accountFunnel, journeyFunnel } from "./funnel";
import { bucketsOf, coverageFor, overview, scopeOf, type ReportQuery, type Tab } from "./report";
import {
  browserSplit,
  campaigns,
  countrySplit,
  deviceSplit,
  exitPages,
  internalSessionCount,
  landingPages,
  osSplit,
  pagesTable,
  referrerHosts,
  sourceTypes,
  trafficSeries,
  trafficTotals,
} from "./traffic";

/** Everything one dashboard tab shows, already aggregated. */

export function trafficSection(query: ReportQuery) {
  const scope = scopeOf(query);
  const list = bucketsOf(query);
  return {
    coverage: coverageFor(scope),
    totals: trafficTotals(scope),
    previous: trafficTotals(scopeOf(query, true)),
    buckets: list,
    series: trafficSeries(scope, list),
    pages: pagesTable(scope, { page: query.pagesPage, sort: query.pagesSort }),
    landing: landingPages(scope),
    exits: exitPages(scope),
    sources: sourceTypes(scope),
    referrers: referrerHosts(scope),
    campaigns: campaigns(scope),
    devices: deviceSplit(scope),
    browsers: browserSplit(scope),
    os: osSplit(scope),
    countries: countrySplit(scope),
    internalSessions: internalSessionCount(scope),
  };
}

export function funnelSection(query: ReportQuery) {
  const scope = scopeOf(query);
  const prev = scopeOf(query, true);
  return {
    coverage: coverageFor(scope),
    journey: journeyFunnel(scope),
    journeyPrevious: journeyFunnel(prev),
    accounts: accountFunnel(scope),
    accountsPrevious: accountFunnel(prev),
  };
}

export function accountsSection(query: ReportQuery, now = Date.now()) {
  const scope = scopeOf(query);
  const list = bucketsOf(query);
  return {
    buckets: list,
    report: accountsReport(scope, list, now),
    previous: accountsReport(scopeOf(query, true), [], now),
    visitors: trafficTotals(scope).visitors,
    coverage: coverageFor(scope),
    cohorts: cohorts(query.range.tz, now),
    users: usersTable({ page: query.usersPage }),
  };
}

export function scansSection(query: ReportQuery) {
  const list = bucketsOf(query);
  return { buckets: list, report: scansReport(scopeOf(query), list), previous: scansReport(scopeOf(query, true), []) };
}

export function revenueSection(query: ReportQuery) {
  const list = bucketsOf(query);
  return { buckets: list, report: revenueReport(scopeOf(query), list), previous: revenueReport(scopeOf(query, true), []) };
}

export function healthSection(query: ReportQuery) {
  const list = bucketsOf(query);
  return { buckets: list, report: healthReport(scopeOf(query), list), previous: healthReport(scopeOf(query, true), []) };
}

/** JSON for the API: the tab's data, with users' email addresses left out. */
export function sectionData(tab: Tab, query: ReportQuery): unknown {
  switch (tab) {
    case "overview":
      return overview(query);
    case "traffic":
      return trafficSection(query);
    case "funnel":
      return funnelSection(query);
    case "accounts": {
      const data = accountsSection(query);
      return { ...data, users: { ...data.users, rows: data.users.rows.map(({ email: _email, ...rest }) => rest) } };
    }
    case "scans":
      return scansSection(query);
    case "revenue":
      return revenueSection(query);
    case "health":
      return healthSection(query);
  }
}
