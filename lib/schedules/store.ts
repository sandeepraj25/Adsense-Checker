import { many, one, run } from "@/lib/db";
import { getActiveSubscription } from "@/lib/db/billing";
import { entitlementBlock, hasFeature } from "@/lib/entitlement";
import { newId } from "@/lib/ids";

/**
 * Weekly rescans (feature 53): the schedule rows.
 *
 * One row per account and site (UNIQUE in the database). Turning a
 * schedule on sets the next run a week after the latest scan of the site;
 * turning it off keeps the row, so its history stays readable. Due rows
 * are claimed with a lock before work starts, so the server's own tick
 * and the scheduler endpoint can both run without doubling a scan.
 */

export const WEEK_MS = 7 * 86_400_000;
export const SCHEDULE_FEATURE = "scheduled_rescan";

export type ScheduleState = "active" | "paused" | "disabled";

export type Schedule = {
  id: string;
  userId: string;
  domain: string;
  enabled: boolean;
  state: ScheduleState;
  stateReason: string | null;
  nextRunAt: number;
  lastRunAt: number | null;
  lastReportId: string | null;
  lastOutcome: string | null;
};

type Row = {
  id: string;
  user_id: string;
  domain: string;
  enabled: number;
  state: ScheduleState;
  state_reason: string | null;
  next_run_at: number;
  attempt: number;
  failed_weeks: number;
  locked_until: number | null;
  last_run_at: number | null;
  last_report_id: string | null;
  last_outcome: string | null;
  paused_since: number | null;
  created_at: number;
  updated_at: number;
};

export type ScheduleRow = Row;

function toSchedule(row: Row): Schedule {
  return {
    id: row.id,
    userId: row.user_id,
    domain: row.domain,
    enabled: row.enabled === 1,
    state: row.state,
    stateReason: row.state_reason,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastReportId: row.last_report_id,
    lastOutcome: row.last_outcome,
  };
}

export function getSchedule(userId: string, domain: string): Schedule | null {
  const row = one<Row>("SELECT * FROM scan_schedules WHERE user_id = ? AND domain = ?", [userId, domain]);
  return row ? toSchedule(row) : null;
}

export function findScheduleRow(id: string): Row | null {
  return one<Row>("SELECT * FROM scan_schedules WHERE id = ?", [id]);
}

/** Whether this account may schedule rescans right now (plan active and including the feature). */
export function canSchedule(userId: string): { ok: true } | { ok: false; reason: string } {
  const subscription = getActiveSubscription(userId);
  const blocked = entitlementBlock(subscription);
  if (blocked) return { ok: false, reason: blocked.message };
  if (!hasFeature(subscription, SCHEDULE_FEATURE as Parameters<typeof hasFeature>[1])) {
    return { ok: false, reason: "Your plan doesn't include weekly rescans." };
  }
  return { ok: true };
}

/** Turns a site's weekly rescan on or off. Entitlement and site ownership are checked by the caller. */
export function setSchedule(input: { userId: string; domain: string; enabled: boolean; now?: number }): Schedule {
  const now = input.now ?? Date.now();
  const existing = one<Row>("SELECT * FROM scan_schedules WHERE user_id = ? AND domain = ?", [input.userId, input.domain]);
  if (!input.enabled) {
    if (existing) {
      run(
        "UPDATE scan_schedules SET enabled = 0, state = 'disabled', state_reason = 'Turned off by you.', updated_at = ? WHERE id = ?",
        [now, existing.id],
      );
    }
    return toSchedule(one<Row>("SELECT * FROM scan_schedules WHERE user_id = ? AND domain = ?", [input.userId, input.domain]) ?? {
      id: "",
      user_id: input.userId,
      domain: input.domain,
      enabled: 0,
      state: "disabled",
      state_reason: "Not turned on.",
      next_run_at: 0,
      attempt: 0,
      failed_weeks: 0,
      locked_until: null,
      last_run_at: null,
      last_report_id: null,
      last_outcome: null,
      paused_since: null,
      created_at: now,
      updated_at: now,
    });
  }
  if (existing?.enabled === 1) return toSchedule(existing); // already on: keep its cadence

  const latest = one<{ at: number }>(
    "SELECT MAX(started_at) AS at FROM reports WHERE user_id = ? AND domain = ? AND state = 'complete'",
    [input.userId, input.domain],
  )?.at;
  const next = Math.max(now, latest ?? now) + WEEK_MS;
  if (existing) {
    run(
      `UPDATE scan_schedules SET enabled = 1, state = 'active', state_reason = NULL, next_run_at = ?, attempt = 0, failed_weeks = 0,
              paused_since = NULL, locked_until = NULL, updated_at = ? WHERE id = ?`,
      [next, now, existing.id],
    );
  } else {
    run(
      `INSERT INTO scan_schedules (id, user_id, domain, enabled, state, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'active', ?, ?, ?)
       ON CONFLICT(user_id, domain) DO NOTHING`,
      [newId("sch"), input.userId, input.domain, next, now, now],
    );
  }
  return toSchedule(one<Row>("SELECT * FROM scan_schedules WHERE user_id = ? AND domain = ?", [input.userId, input.domain])!);
}

/** Claims up to `limit` due schedules for this worker. */
export function claimDueSchedules(now: number, limit: number, lockMs = 15 * 60_000): Row[] {
  const due = many<{ id: string }>(
    `SELECT id FROM scan_schedules
      WHERE enabled = 1 AND state IN ('active', 'paused') AND next_run_at <= ?
        AND (locked_until IS NULL OR locked_until < ?)
      ORDER BY next_run_at ASC LIMIT ?`,
    [now, now, limit],
  );
  const claimed: Row[] = [];
  for (const { id } of due) {
    const ok = run(
      `UPDATE scan_schedules SET locked_until = ?, updated_at = ? WHERE id = ? AND enabled = 1
          AND next_run_at <= ? AND (locked_until IS NULL OR locked_until < ?)`,
      [now + lockMs, now, id, now, now],
    ).changes;
    if (ok === 1) claimed.push(one<Row>("SELECT * FROM scan_schedules WHERE id = ?", [id])!);
  }
  return claimed;
}

export function updateScheduleAfterRun(
  id: string,
  fields: {
    state: ScheduleState;
    enabled?: boolean;
    reason?: string | null;
    nextRunAt: number;
    attempt?: number;
    failedWeeks?: number;
    pausedSince?: number | null;
    lastRunAt?: number;
    lastReportId?: string | null;
    lastOutcome: string;
  },
  now: number,
): void {
  run(
    `UPDATE scan_schedules SET state = ?, enabled = COALESCE(?, enabled), state_reason = ?, next_run_at = ?,
            attempt = COALESCE(?, attempt), failed_weeks = COALESCE(?, failed_weeks), paused_since = ?,
            last_run_at = COALESCE(?, last_run_at), last_report_id = COALESCE(?, last_report_id), last_outcome = ?,
            locked_until = NULL, updated_at = ?
      WHERE id = ?`,
    [
      fields.state,
      fields.enabled === undefined ? null : fields.enabled ? 1 : 0,
      fields.reason ?? null,
      fields.nextRunAt,
      fields.attempt ?? null,
      fields.failedWeeks ?? null,
      fields.pausedSince ?? null,
      fields.lastRunAt ?? null,
      fields.lastReportId ?? null,
      fields.lastOutcome,
      now,
      id,
    ],
  );
}

export function recordRun(input: {
  scheduleId: string;
  userId: string;
  domain: string;
  reportId?: string | null;
  outcome: "complete" | "failed" | "skipped" | "paused" | "disabled";
  detail: string;
  changes?: unknown;
  emailPending?: boolean;
  now: number;
}): string {
  const id = newId("srn");
  run(
    `INSERT INTO schedule_runs (id, schedule_id, user_id, domain, report_id, outcome, detail, changes_json, email_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.scheduleId,
      input.userId,
      input.domain,
      input.reportId ?? null,
      input.outcome,
      input.detail.slice(0, 500),
      input.changes === undefined ? null : JSON.stringify(input.changes),
      input.emailPending ? "pending" : "none",
      input.now,
    ],
  );
  return id;
}

export type ScheduleRun = {
  id: string;
  report_id: string | null;
  outcome: string;
  detail: string;
  email_status: string;
  created_at: number;
};

export function recentRuns(scheduleId: string, limit = 5): ScheduleRun[] {
  return many<ScheduleRun>(
    "SELECT id, report_id, outcome, detail, email_status, created_at FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    [scheduleId, limit],
  );
}
