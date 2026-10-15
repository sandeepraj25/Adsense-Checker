import { promoteDeferred } from "./feedback";
import { processFeedbackEmails } from "./feedback-email";
import { lastTrainingAttempt } from "./store";
import { runTraining, type TrainingResult } from "./train";

/**
 * The prediction system's background work, safe to run from several
 * places at once (the server's own tick, the scheduler endpoint): every
 * step is claimed in the database.
 *
 *   1. deferred answers from accounts now 3 days old → accepted
 *   2. due feedback emails → sent
 *   3. nightly retraining: once a day in the ML_TRAIN_HOUR_UTC hour
 *      (default 21 UTC = 02:30 IST), or as a catch-up when the last
 *      attempt is more than 36 hours old (a server that was down at
 *      that hour still trains)
 */

const HOUR = 3_600_000;

export function trainingHourUtc(): number {
  const raw = Number.parseInt(process.env.ML_TRAIN_HOUR_UTC ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 21;
}

export function trainingDue(now: number, last: number | null): boolean {
  if (last === null) return true;
  if (now - last >= 36 * HOUR) return true;
  return new Date(now).getUTCHours() === trainingHourUtc() && now - last >= 20 * HOUR;
}

export async function runMlJob(options: { now?: number; forceTraining?: boolean; trigger?: "nightly" | "cron" } = {}): Promise<{
  promoted: number;
  emails: Record<string, number>;
  training: TrainingResult | null;
  summary: string;
}> {
  const now = options.now ?? Date.now();
  const promoted = promoteDeferred(now);
  const emails = await processFeedbackEmails(now);
  const training = options.forceTraining || trainingDue(now, lastTrainingAttempt())
    ? await runTraining({ trigger: options.trigger ?? "nightly", now })
    : null;
  const sent = emails.sent ?? 0;
  const summary = [
    `${promoted} deferred answer${promoted === 1 ? "" : "s"} accepted`,
    `${sent} feedback email${sent === 1 ? "" : "s"} sent${emails.retry ? `, ${emails.retry} to retry` : ""}${emails.failed ? `, ${emails.failed} failed` : ""}`,
    training ? `training: ${training.message}` : "training not due",
  ].join("; ");
  return { promoted, emails, training, summary };
}

type GlobalWithJob = typeof globalThis & { __mlJobRunning?: boolean; __mlJobLast?: number };
const globalRef = globalThis as GlobalWithJob;

/** The server tick: runs the job unless this process ran it within `minIntervalMs`. */
export async function runMlJobThrottled(minIntervalMs = 4 * 60_000): Promise<void> {
  const now = Date.now();
  if (globalRef.__mlJobRunning || (globalRef.__mlJobLast && now - globalRef.__mlJobLast < minIntervalMs)) return;
  globalRef.__mlJobRunning = true;
  globalRef.__mlJobLast = now;
  try {
    await runMlJob({ now });
  } catch (error) {
    console.error("[ml] job failed", error instanceof Error ? error.message : error);
  } finally {
    globalRef.__mlJobRunning = false;
  }
}
