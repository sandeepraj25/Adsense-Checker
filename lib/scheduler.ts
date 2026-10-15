import type { NextResponse } from "next/server";

import { many, run } from "@/lib/db";
import { jsonError, jsonOk, jsonServerError, type ApiFailure } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { safeEqual } from "@/lib/secrets";

/**
 * The scheduled jobs, and the one way an outside scheduler may start them.
 *
 * Three jobs, each with its own endpoint, its own work and its own claims
 * in the database — they are not merged:
 *
 *   checkout-alerts  payment-failure and abandoned-checkout alerts to the
 *                    admin's alert address (lib/alerts/job.ts)
 *   ml               prediction feedback: accepts deferred answers, emails
 *                    customers the 14-day "did AdSense approve?" question,
 *                    trains nightly (lib/ml/job.ts)
 *   rescans          Pro weekly rescans and their change emails
 *                    (lib/schedules/job.ts)
 *
 * They share only the gate below. That is safe: all three are internal
 * maintenance with the same trust level, none takes input that widens what
 * it does (ml's `train` only runs early what runs nightly anyway), and
 * each keeps its own rate-limit bucket. One CRON_SECRET, rotated in one
 * place, guards all three.
 *
 * Every authenticated call is recorded (time, success, summary) so the
 * admin pages can show whether a real scheduler has ever called — the
 * server's own background tick and the admin's "Run now" button are
 * recorded separately and never count as the scheduler.
 */

export type ScheduledJob = "checkout-alerts" | "ml" | "rescans";
export const SCHEDULED_JOBS: readonly ScheduledJob[] = ["checkout-alerts", "ml", "rescans"];

/** Who started a run. Only "scheduler" proves an external schedule works. */
export type JobTrigger = "scheduler" | "background" | "admin";

const MIN_SECRET_LENGTH = 32;

export function schedulerSecretConfigured(): boolean {
  return (process.env.CRON_SECRET?.trim().length ?? 0) >= MIN_SECRET_LENGTH;
}

/**
 * The gate for a scheduler request. Returns null when the request may run
 * the job, or the response to send instead:
 *   503 CRON_SECRET missing or under 32 characters (the endpoint is shut)
 *   429 more than 30 calls a minute from one address, per job
 *   401 no bearer token, or the wrong one (compared in constant time)
 */
export function authorizeScheduler(request: Request, job: ScheduledJob): NextResponse<ApiFailure> | null {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    return jsonError("FORBIDDEN", "Scheduled jobs are not configured on this server (CRON_SECRET is missing or too short).", { status: 503 });
  }
  if (!rateLimit(`cron:${job}:${clientIp(request)}`, 30, 60_000).ok) {
    return jsonError("RATE_LIMITED", "Too many requests.");
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !safeEqual(token, secret)) {
    return jsonError("UNAUTHENTICATED", "Not allowed.", { status: 401 });
  }
  return null;
}

/**
 * Runs `work` for an authorised scheduler request and records the call,
 * whether the job succeeded or not. An internal error is answered with the
 * standard server-error response (nothing internal is returned).
 */
export async function runForScheduler<T extends { summary: string }>(
  job: ScheduledJob,
  work: () => Promise<T>,
  respond: (result: T) => Record<string, unknown>,
): Promise<NextResponse> {
  const started = Date.now();
  try {
    const result = await work();
    recordSchedulerCall(job, { at: started, ok: true, summary: result.summary });
    return jsonOk(respond(result));
  } catch (error) {
    recordSchedulerCall(job, { at: started, ok: false, summary: "The job failed; see the server log." });
    return jsonServerError(`jobs/${job}`, error);
  }
}

/* ── the record of scheduler calls ─────────────────────────────── */

export type SchedulerCall = { at: number; ok: boolean; summary: string };

const key = (job: ScheduledJob) => `scheduler.last_call.${job}`;

export function recordSchedulerCall(job: ScheduledJob, call: SchedulerCall): void {
  try {
    run(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'scheduler')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [key(job), JSON.stringify({ ...call, summary: call.summary.slice(0, 300) }), call.at],
    );
  } catch (error) {
    // A bookkeeping failure must not fail the job it describes.
    console.error(`[scheduler] could not record the ${job} call: ${error instanceof Error ? error.message : error}`);
  }
}

export function lastSchedulerCalls(): Record<ScheduledJob, SchedulerCall | null> {
  const out = { "checkout-alerts": null, ml: null, rescans: null } as Record<ScheduledJob, SchedulerCall | null>;
  const rows = many<{ key: string; value: string }>("SELECT key, value FROM app_settings WHERE key LIKE 'scheduler.last_call.%'");
  for (const row of rows) {
    const job = row.key.slice("scheduler.last_call.".length) as ScheduledJob;
    if (!SCHEDULED_JOBS.includes(job)) continue;
    try {
      const parsed = JSON.parse(row.value) as SchedulerCall;
      if (typeof parsed.at === "number") out[job] = { at: parsed.at, ok: parsed.ok === true, summary: String(parsed.summary ?? "") };
    } catch {
      /* unreadable: treated as never called */
    }
  }
  return out;
}

/**
 * How the admin pages describe a job's schedule. "verified" needs a real
 * scheduler call within `staleAfterMs` (default 30 minutes: three missed
 * 10-minute runs); the background tick never makes a job "verified".
 */
export type ScheduleHealth =
  | { state: "not_configured"; message: string }
  | { state: "never_called"; message: string }
  | { state: "stale"; message: string; last: SchedulerCall }
  | { state: "failing"; message: string; last: SchedulerCall }
  | { state: "verified"; message: string; last: SchedulerCall };

export function scheduleHealth(job: ScheduledJob, now = Date.now(), staleAfterMs = 30 * 60_000): ScheduleHealth {
  if (!schedulerSecretConfigured()) {
    return { state: "not_configured", message: "CRON_SECRET is not set (or is under 32 characters) on this server, so no scheduler can call this job." };
  }
  const last = lastSchedulerCalls()[job];
  if (!last) {
    return { state: "never_called", message: "CRON_SECRET is set, but no scheduler has called this job yet. Production scheduling is not verified." };
  }
  if (!last.ok) return { state: "failing", message: "The last scheduler call reached the server, but the job failed. See the server log.", last };
  if (now - last.at > staleAfterMs) {
    return { state: "stale", message: "The scheduler called before, but not recently. Check that the scheduled job is still running.", last };
  }
  return { state: "verified", message: "A scheduler called this job recently, with the right secret, and it ran.", last };
}
