import { startAudit } from "@/lib/audit-service";
import { one } from "@/lib/db";
import { findUserById } from "@/lib/db/accounts";
import { getActiveSubscription, settleBilling } from "@/lib/db/billing";
import { formatDate } from "@/lib/format";
import { diffScans, linesOfReport, previousLiveReport } from "@/lib/analysis/insights/history";

import { processRescanEmails } from "./email";
import { canSchedule, claimDueSchedules, recordRun, updateScheduleAfterRun, WEEK_MS, type ScheduleRow } from "./store";

/**
 * Runs the weekly rescans that are due. Each one goes through the normal
 * scan path (startAudit), so plan checks, the monthly allowance and every
 * limit apply exactly as for a scan started by hand.
 *
 *   plan expired / feature removed  paused; checked again daily; turned
 *                                   off after 30 days paused
 *   allowance used up               paused until it resets
 *   a scan of this site running     skipped, tried again in 30 minutes
 *   site unreachable / scan failed  retried after 1 and 6 hours; after
 *                                   that the week counts as failed and
 *                                   the next weekly slot is used; three
 *                                   failed weeks in a row turn it off
 *   account blocked or deleted,     turned off
 *   address no longer allowed
 *
 * Every attempt is logged in schedule_runs with its reason. When findings
 * changed in a meaningful way, a change email is queued on that run.
 */

const DAY = 86_400_000;
const RETRY_MS = [3_600_000, 6 * 3_600_000];
const MAX_FAILED_WEEKS = 3;
const MAX_PAUSE_MS = 30 * DAY;
const PER_TICK = 3;

function nextWeeklySlot(row: ScheduleRow, now: number): number {
  let next = row.next_run_at;
  while (next <= now) next += WEEK_MS;
  return next;
}

async function runOne(row: ScheduleRow, now: number): Promise<string> {
  const user = findUserById(row.user_id);
  if (!user || user.isBlocked) {
    const reason = "Turned off: the account is suspended.";
    updateScheduleAfterRun(row.id, { state: "disabled", enabled: false, reason, nextRunAt: row.next_run_at, lastOutcome: "disabled" }, now);
    recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "disabled", detail: reason, now });
    return "disabled";
  }

  const pause = (reason: string, until: number) => {
    const since = row.paused_since ?? now;
    if (now - since > MAX_PAUSE_MS) {
      const off = `Turned off after 30 days paused. Last reason: ${reason}`;
      updateScheduleAfterRun(row.id, { state: "disabled", enabled: false, reason: off, nextRunAt: row.next_run_at, pausedSince: since, lastOutcome: "disabled" }, now);
      recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "disabled", detail: off, now });
      return "disabled";
    }
    updateScheduleAfterRun(row.id, { state: "paused", reason, nextRunAt: until, pausedSince: since, lastOutcome: "paused" }, now);
    recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "paused", detail: reason, now });
    return "paused";
  };

  const allowed = canSchedule(row.user_id);
  if (!allowed.ok) return pause(`Paused: ${allowed.reason}`, now + DAY);

  const running = one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND domain = ? AND state = 'running'", [row.user_id, row.domain])?.n ?? 0;
  if (running > 0) {
    updateScheduleAfterRun(row.id, { state: row.state, reason: row.state_reason, nextRunAt: now + 30 * 60_000, pausedSince: row.paused_since, lastOutcome: "skipped" }, now);
    recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "skipped", detail: "A scan of this site was already running; trying again in 30 minutes.", now });
    return "skipped";
  }

  const result = await startAudit(user, row.domain, { wait: true });
  const finishedAt = Date.now();

  if (result.ok && !result.demo) {
    const report = result.report;
    const previous = previousLiveReport(row.user_id, report.websiteId, report.id, finishedAt);
    const diff = previous
      ? diffScans({
          previous: { id: previous.id, ref: previous.ref, score: previous.score, at: previous.startedAt, features: previous.features, lines: linesOfReport(previous.id) },
          current: { score: report.score, features: report.features, lines: linesOfReport(report.id) },
        })
      : null;
    updateScheduleAfterRun(
      row.id,
      { state: "active", reason: null, nextRunAt: nextWeeklySlot(row, finishedAt), attempt: 0, failedWeeks: 0, pausedSince: null, lastRunAt: finishedAt, lastReportId: report.id, lastOutcome: "complete" },
      finishedAt,
    );
    recordRun({
      scheduleId: row.id,
      userId: row.user_id,
      domain: row.domain,
      reportId: report.id,
      outcome: "complete",
      detail: diff
        ? `Score ${Math.round(diff.previous.score)} → ${report.score}; ${diff.appeared.length + diff.worsened.length} new or worse, ${diff.resolved.length} fixed.${diff.meaningful ? " Change email queued." : " No meaningful change, no email."}`
        : `Score ${report.score}. No earlier scan to compare with.`,
      changes: diff ?? undefined,
      emailPending: Boolean(diff?.meaningful),
      now: finishedAt,
    });
    return "complete";
  }

  const code = result.ok ? "SITE_UNREACHABLE" : result.code;
  const message = result.ok ? "The site could not be reached (a sample report was produced instead)." : result.message;
  if (code === "SCAN_IN_PROGRESS") {
    updateScheduleAfterRun(row.id, { state: row.state, reason: row.state_reason, nextRunAt: now + 30 * 60_000, pausedSince: row.paused_since, lastOutcome: "skipped" }, now);
    recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "skipped", detail: `${message} Trying again in 30 minutes.`, now });
    return "skipped";
  }
  if (code === "LIMIT_REACHED") {
    const subscription = getActiveSubscription(row.user_id);
    const resets = subscription?.cycleEnd ?? now + DAY;
    return pause(`Paused: this month's scan allowance is used up. Resumes after it resets on ${formatDate(resets)}.`, resets + 3_600_000);
  }
  if (code === "NO_ACTIVE_PLAN" || code === "PLAN_EXPIRED" || code === "FEATURE_LOCKED") return pause(`Paused: ${message}`, now + DAY);
  if (code === "ACCOUNT_BLOCKED" || code === "INVALID_URL" || code === "URL_NOT_ALLOWED") {
    const reason = `Turned off: ${message}`;
    updateScheduleAfterRun(row.id, { state: "disabled", enabled: false, reason, nextRunAt: row.next_run_at, lastOutcome: "disabled" }, now);
    recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "disabled", detail: reason, now });
    return "disabled";
  }

  // A failed scan (site down, analysis error): retry, then give up for the week.
  const attempt = row.attempt + 1;
  if (attempt <= RETRY_MS.length) {
    updateScheduleAfterRun(row.id, { state: "active", reason: `Last attempt failed: ${message}`, nextRunAt: finishedAt + RETRY_MS[attempt - 1]!, attempt, pausedSince: null, lastRunAt: finishedAt, lastOutcome: "failed" }, finishedAt);
    recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "failed", detail: `${message} Retrying in ${attempt === 1 ? "1 hour" : "6 hours"}.`, now: finishedAt });
    return "failed";
  }
  const failedWeeks = row.failed_weeks + 1;
  if (failedWeeks >= MAX_FAILED_WEEKS) {
    const reason = `Turned off: the scan failed ${MAX_FAILED_WEEKS} weeks in a row. Last error: ${message}`;
    updateScheduleAfterRun(row.id, { state: "disabled", enabled: false, reason, nextRunAt: row.next_run_at, attempt: 0, failedWeeks, lastRunAt: finishedAt, lastOutcome: "disabled" }, finishedAt);
    recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "disabled", detail: reason, now: finishedAt });
    return "disabled";
  }
  updateScheduleAfterRun(
    row.id,
    { state: "active", reason: `This week's scan failed: ${message}`, nextRunAt: nextWeeklySlot(row, finishedAt), attempt: 0, failedWeeks, pausedSince: null, lastRunAt: finishedAt, lastOutcome: "failed" },
    finishedAt,
  );
  recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "failed", detail: `${message} Giving up for this week.`, now: finishedAt });
  return "failed";
}

export async function runScheduledRescans(now = Date.now(), limit = PER_TICK): Promise<{ tally: Record<string, number>; emails: Record<string, number>; summary: string }> {
  settleBilling(now);
  const claimed = claimDueSchedules(now, limit);
  const tally: Record<string, number> = {};
  for (const row of claimed) {
    let outcome: string;
    try {
      outcome = await runOne(row, now);
    } catch (error) {
      // Never leave a schedule locked or silent: log, record, retry later.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[schedules] rescan of ${row.domain} failed unexpectedly: ${message}`);
      updateScheduleAfterRun(row.id, { state: row.state, reason: row.state_reason, nextRunAt: now + RETRY_MS[0]!, pausedSince: row.paused_since, lastOutcome: "failed" }, now);
      recordRun({ scheduleId: row.id, userId: row.user_id, domain: row.domain, outcome: "failed", detail: "Unexpected error; retrying in an hour.", now });
      outcome = "failed";
    }
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    console.log(`[schedules] ${row.domain}: ${outcome}`);
  }
  const emails = await processRescanEmails(Date.now());
  const summary = `${claimed.length} due: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}; ${emails.sent ?? 0} change email(s) sent`;
  return { tally, emails, summary };
}

type GlobalWithJob = typeof globalThis & { __rescanJobRunning?: boolean; __rescanJobLast?: number };
const globalRef = globalThis as GlobalWithJob;

/** The server tick: runs the job unless this process ran it within `minIntervalMs`. */
export async function runScheduledRescansThrottled(minIntervalMs = 4 * 60_000): Promise<void> {
  const now = Date.now();
  if (globalRef.__rescanJobRunning || (globalRef.__rescanJobLast && now - globalRef.__rescanJobLast < minIntervalMs)) return;
  globalRef.__rescanJobRunning = true;
  globalRef.__rescanJobLast = now;
  try {
    await runScheduledRescans(now);
  } catch (error) {
    console.error("[schedules] job failed", error instanceof Error ? error.message : error);
  } finally {
    globalRef.__rescanJobRunning = false;
  }
}
