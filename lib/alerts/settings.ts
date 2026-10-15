import { one, run } from "@/lib/db";

/**
 * The two settings the alerts need, stored in `app_settings`.
 * Nothing here is a credential: the email provider's key stays in the
 * environment (see lib/email).
 */

const ALERT_EMAIL = "alerts.email";
const GRACE_MINUTES = "alerts.abandon_grace_minutes";
const LAST_RUN = "alerts.job_last_run";

export const DEFAULT_GRACE_MINUTES = 30;
export const MIN_GRACE_MINUTES = 5;
export const MAX_GRACE_MINUTES = 24 * 60;

function get(key: string): { value: string; updatedAt: number; updatedBy: string | null } | null {
  const row = one<{ value: string; updated_at: number; updated_by: string | null }>(
    "SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?",
    [key],
  );
  return row ? { value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
}

function set(key: string, value: string, by: string | null): void {
  run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, value, Date.now(), by],
  );
}

export function normalizeAlertEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

export function alertEmail(): string | null {
  const row = get(ALERT_EMAIL);
  return row?.value ? row.value : null;
}

export function alertEmailSetting(): { email: string | null; updatedAt: number | null; updatedBy: string | null } {
  const row = get(ALERT_EMAIL);
  return { email: row?.value || null, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
}

/** An empty string turns alerts off. */
export function setAlertEmail(email: string | null, by: string): void {
  set(ALERT_EMAIL, email ?? "", by);
}

export function graceMinutes(): number {
  const raw = Number.parseInt(get(GRACE_MINUTES)?.value ?? "", 10);
  return Number.isInteger(raw) && raw >= MIN_GRACE_MINUTES && raw <= MAX_GRACE_MINUTES ? raw : DEFAULT_GRACE_MINUTES;
}

export function setGraceMinutes(minutes: number, by: string): void {
  set(GRACE_MINUTES, String(minutes), by);
}

export type JobRunTrigger = "scheduler" | "background" | "admin";

export function recordJobRun(summary: string, now = Date.now(), trigger: JobRunTrigger = "admin"): void {
  set(LAST_RUN, JSON.stringify({ at: now, summary, trigger }), "job");
}

/** The last run from any source; `trigger` is absent on rows from before it was recorded. */
export function lastJobRun(): { at: number; summary: string; trigger: JobRunTrigger | null } | null {
  const row = get(LAST_RUN);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { at: number; summary: string; trigger?: string };
    if (typeof parsed.at !== "number") return null;
    const trigger = parsed.trigger === "scheduler" || parsed.trigger === "background" || parsed.trigger === "admin" ? parsed.trigger : null;
    return { at: parsed.at, summary: parsed.summary, trigger };
  } catch {
    return null;
  }
}
