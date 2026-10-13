import { many, one, run, tx } from "./index";
import {
  toReport,
  toReportIssue,
  toWebsite,
  type AnalysisMode,
  type CategoryScore,
  type IssuePriority,
  type IssueStatus,
  type PageScore,
  type Report,
  type ReportIssue,
  type ReportIssueRow,
  type ReportMetrics,
  type ReportRow,
  type Verdict,
  type Website,
  type WebsiteRow,
} from "./types";
import { newId, newReportRef } from "@/lib/ids";
import type { FeatureKey, PlanId } from "@/lib/plans";

/* ── websites ───────────────────────────────────────────────────── */

/** Idempotent per (user, domain) so re-checks reuse the same site row. */
export function upsertWebsite(userId: string, domain: string): Website {
  const existing = one<WebsiteRow>(
    "SELECT * FROM websites WHERE user_id = ? AND domain = ?",
    [userId, domain],
  );
  if (existing) return toWebsite(existing);

  const row: WebsiteRow = {
    id: newId("web"),
    user_id: userId,
    domain,
    created_at: Date.now(),
    last_checked_at: null,
  };
  run(
    `INSERT INTO websites (id, user_id, domain, created_at, last_checked_at)
     VALUES (?, ?, ?, ?, ?)`,
    [row.id, row.user_id, row.domain, row.created_at, row.last_checked_at],
  );
  return toWebsite(row);
}

export function countWebsites(userId: string): number {
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM websites WHERE user_id = ?",
    [userId],
  );
  return row?.n ?? 0;
}

export function websiteExists(userId: string, domain: string): boolean {
  return (
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM websites WHERE user_id = ? AND domain = ?",
      [userId, domain],
    )?.n === 1
  );
}

export function touchWebsite(id: string, when = Date.now()): void {
  run("UPDATE websites SET last_checked_at = ? WHERE id = ?", [when, id]);
}

export function listWebsites(userId: string): Website[] {
  return many<WebsiteRow>(
    "SELECT * FROM websites WHERE user_id = ? ORDER BY COALESCE(last_checked_at, created_at) DESC",
    [userId],
  ).map(toWebsite);
}

/* ── reports ────────────────────────────────────────────────────── */

export function createRunningReport(input: {
  userId: string;
  websiteId: string;
  subscriptionId: string | null;
  url: string;
  domain: string;
  planId: PlanId;
  planName: string;
  engineVersion: string;
  analysisMode: AnalysisMode;
  /** The features this run is entitled to, recorded before it starts. */
  features: FeatureKey[];
}): Report {
  const now = Date.now();
  const row: ReportRow = {
    id: newId("rep"),
    ref: newReportRef(),
    user_id: input.userId,
    website_id: input.websiteId,
    subscription_id: input.subscriptionId,
    url: input.url,
    domain: input.domain,
    score: 0,
    verdict: "not_ready",
    state: "running",
    categories_json: "[]",
    passed_count: 0,
    warning_count: 0,
    critical_count: 0,
    plan_id: input.planId,
    plan_name: input.planName,
    engine_version: input.engineVersion,
    analysis_mode: input.analysisMode,
    pages_fetched: 0,
    error_message: null,
    started_at: now,
    finished_at: null,
    duration_ms: null,
    created_at: now,
    features_json: JSON.stringify(input.features),
    pages_json: "[]",
    metrics_json: "{}",
    checks_run: 0,
    locked_json: "[]",
  };

  run(
    `INSERT INTO reports
       (id, ref, user_id, website_id, subscription_id, url, domain, score,
        verdict, state, categories_json, passed_count, warning_count,
        critical_count, plan_id, plan_name, engine_version, analysis_mode,
        pages_fetched, error_message, started_at, finished_at, duration_ms,
        created_at, features_json, pages_json, metrics_json, checks_run,
        locked_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.ref,
      row.user_id,
      row.website_id,
      row.subscription_id,
      row.url,
      row.domain,
      row.score,
      row.verdict,
      row.state,
      row.categories_json,
      row.passed_count,
      row.warning_count,
      row.critical_count,
      row.plan_id,
      row.plan_name,
      row.engine_version,
      row.analysis_mode,
      row.pages_fetched,
      row.error_message,
      row.started_at,
      row.finished_at,
      row.duration_ms,
      row.created_at,
      row.features_json,
      row.pages_json,
      row.metrics_json,
      row.checks_run,
      row.locked_json,
    ],
  );

  return toReport(row);
}

export type NewIssue = {
  checkId: string;
  categoryId: string;
  label: string;
  status: IssueStatus;
  priority: IssuePriority;
  detail: string;
  recommendation?: string | null;
  evidence?: string | null;
  /** The plan feature that produced this finding. */
  feature?: FeatureKey | null;
};

/** Report body and its issues land together or not at all. */
export function completeReport(input: {
  reportId: string;
  score: number;
  verdict: Verdict;
  categories: CategoryScore[];
  passedCount: number;
  warningCount: number;
  criticalCount: number;
  pagesFetched: number;
  issues: NewIssue[];
  features: FeatureKey[];
  locked: FeatureKey[];
  pages: PageScore[];
  metrics: ReportMetrics;
  checksRun: number;
}): void {
  const now = Date.now();
  tx(() => {
    run(
      `UPDATE reports
          SET state = 'complete',
              score = ?,
              verdict = ?,
              categories_json = ?,
              passed_count = ?,
              warning_count = ?,
              critical_count = ?,
              pages_fetched = ?,
              features_json = ?,
              locked_json = ?,
              pages_json = ?,
              metrics_json = ?,
              checks_run = ?,
              finished_at = ?,
              duration_ms = ? - started_at
        WHERE id = ?`,
      [
        Math.round(input.score),
        input.verdict,
        JSON.stringify(input.categories),
        input.passedCount,
        input.warningCount,
        input.criticalCount,
        input.pagesFetched,
        JSON.stringify(input.features),
        JSON.stringify(input.locked),
        JSON.stringify(input.pages),
        JSON.stringify(input.metrics),
        input.checksRun,
        now,
        now,
        input.reportId,
      ],
    );

    run("DELETE FROM report_issues WHERE report_id = ?", [input.reportId]);

    input.issues.forEach((issue, index) => {
      run(
        `INSERT INTO report_issues
           (id, report_id, check_id, category_id, label, status, priority,
            detail, recommendation, evidence, sort_order, feature)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId("iss"),
          input.reportId,
          issue.checkId,
          issue.categoryId,
          issue.label,
          issue.status,
          issue.priority,
          issue.detail,
          issue.recommendation ?? null,
          issue.evidence ?? null,
          index,
          issue.feature ?? null,
        ],
      );
    });
  });
}

export function failReport(reportId: string, message: string): void {
  const now = Date.now();
  run(
    `UPDATE reports
        SET state = 'failed', error_message = ?, finished_at = ?,
            duration_ms = ? - started_at
      WHERE id = ?`,
    [message.slice(0, 500), now, now, reportId],
  );
}

export function findReport(id: string): Report | null {
  const row = one<ReportRow>("SELECT * FROM reports WHERE id = ?", [id]);
  return row ? toReport(row) : null;
}

/** Ownership is part of the query, so one user can never read another's. */
export function findReportForUser(id: string, userId: string): Report | null {
  const row = one<ReportRow>(
    "SELECT * FROM reports WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return row ? toReport(row) : null;
}

export function listReports(userId: string, limit = 100): Report[] {
  return many<ReportRow>(
    "SELECT * FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    [userId, limit],
  ).map(toReport);
}

export function latestReport(userId: string): Report | null {
  const row = one<ReportRow>(
    "SELECT * FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId],
  );
  return row ? toReport(row) : null;
}

export function countReports(userId: string): number {
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM reports WHERE user_id = ?",
    [userId],
  );
  return row?.n ?? 0;
}

export function deleteReportForUser(id: string, userId: string): boolean {
  return (
    run("DELETE FROM reports WHERE id = ? AND user_id = ?", [id, userId])
      .changes === 1
  );
}

/**
 * Clears earlier failed attempts on one site before a new run starts.
 *
 * A failed run holds no findings — only the sentence explaining why it
 * stopped. Keeping every one of them turns the history into a wall of
 * identical failures for somebody who simply retried five times after a
 * typo, and buries the successful reports underneath. At most one failure
 * per site survives, which is the one that still tells the person
 * something they did not already know.
 */
export function pruneFailedReports(userId: string, websiteId: string): number {
  return run(
    `DELETE FROM reports
      WHERE user_id = ? AND website_id = ? AND state = 'failed'`,
    [userId, websiteId],
  ).changes;
}

export function listIssues(reportId: string): ReportIssue[] {
  return many<ReportIssueRow>(
    "SELECT * FROM report_issues WHERE report_id = ? ORDER BY sort_order ASC",
    [reportId],
  ).map(toReportIssue);
}

/** Records that a report was produced from demo data, not a live crawl. */
export function setReportAnalysisMode(reportId: string, mode: AnalysisMode): void {
  run("UPDATE reports SET analysis_mode = ? WHERE id = ?", [mode, reportId]);
}

/**
 * Closes reports whose run died mid-flight — a crashed process or a
 * dropped connection leaves the row in 'running' forever otherwise, and
 * a spinner that never resolves is worse than an honest failure.
 *
 * The scan each of those runs consumed is credited back, matching what
 * the audit service does when a run fails while the process is still
 * alive. An interrupted run produced nothing, so charging for it would be
 * charging for our own crash. Refund first, then close the reports —
 * within one transaction, so the count used for the credit and the rows
 * marked failed are guaranteed to be the same set.
 */
export function failStaleReports(olderThanMs = 3 * 60 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  const now = Date.now();

  return tx(() => {
    run(
      `UPDATE subscriptions
          SET scans_used = MAX(
                0,
                scans_used - (
                  SELECT COUNT(*) FROM reports r
                   WHERE r.subscription_id = subscriptions.id
                     AND r.state = 'running'
                     AND r.started_at < ?
                )
              ),
              updated_at = ?
        WHERE id IN (
                SELECT subscription_id FROM reports
                 WHERE state = 'running'
                   AND started_at < ?
                   AND subscription_id IS NOT NULL
              )`,
      [cutoff, now, cutoff],
    );

    return run(
      `UPDATE reports
          SET state = 'failed',
              error_message = 'The analysis was interrupted before it finished.',
              finished_at = ?
        WHERE state = 'running' AND started_at < ?`,
      [now, cutoff],
    ).changes;
  });
}
