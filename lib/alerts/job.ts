import { claimAbandoned, purgeOldCheckouts } from "./checkout";
import { notifyAbandoned, processDue, scrubOldPayloads } from "./notify";
import { graceMinutes, recordJobRun } from "./settings";
import { purgeAnalyticsIfDue } from "@/lib/analytics/store";

/**
 * One pass of the alert job. Safe to run from several places at once —
 * the scheduler's protected endpoint, the admin's "Run now" button, and
 * the server's own background tick — because every claim is a guarded
 * UPDATE in the database and every alert is unique per event.
 *
 *   1. checkouts past the grace period with no payment attempt → abandoned
 *   2. due alerts (new, or retrying after a temporary failure) → sent
 *   3. retention: stale checkout records and old alert bodies removed,
 *      and analytics past its retention period (at most every 6 hours)
 *
 * `now` is a parameter so tests can move the clock instead of waiting.
 */
export async function runAlertJob(now = Date.now()): Promise<{
  abandoned: number;
  delivered: Record<string, number>;
  purged: number;
  summary: string;
}> {
  const claimed = claimAbandoned(now, graceMinutes() * 60_000, 50);
  for (const session of claimed) notifyAbandoned(session, now);
  const delivered = await processDue(now, 25);
  const purged = purgeOldCheckouts(now) + scrubOldPayloads(now);
  purgeAnalyticsIfDue(now);
  const sent = delivered.sent ?? 0;
  const summary = `${claimed.length} abandoned checkout${claimed.length === 1 ? "" : "s"} found, ${sent} alert${sent === 1 ? "" : "s"} sent${
    delivered.retry ? `, ${delivered.retry} to retry` : ""
  }${delivered.failed ? `, ${delivered.failed} failed` : ""}${delivered.skipped ? `, ${delivered.skipped} skipped (no alert email)` : ""}`;
  recordJobRun(summary, now);
  return { abandoned: claimed.length, delivered, purged, summary };
}

type GlobalWithJob = typeof globalThis & { __alertJobRunning?: boolean; __alertJobLast?: number };
const globalRef = globalThis as GlobalWithJob;

/** Runs the job unless this process already ran it in the last `minIntervalMs`. */
export async function runAlertJobThrottled(minIntervalMs = 60_000): Promise<void> {
  const now = Date.now();
  if (globalRef.__alertJobRunning || (globalRef.__alertJobLast && now - globalRef.__alertJobLast < minIntervalMs)) return;
  globalRef.__alertJobRunning = true;
  globalRef.__alertJobLast = now;
  try {
    await runAlertJob(now);
  } catch (error) {
    console.error("[alerts] job failed", error instanceof Error ? error.message : error);
  } finally {
    globalRef.__alertJobRunning = false;
  }
}
