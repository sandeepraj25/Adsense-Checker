import { one, run } from "@/lib/db";
import { isValidIpRule } from "./privacy";
import { isValidTimeZone, RANGE_PRESETS, type RangePreset } from "./time";

/**
 * Analytics settings, stored as one JSON value in `app_settings`.
 *
 * Nothing here is a secret, and nothing here can switch off a security
 * control: the admin audit log, sign-in rate limits and payment
 * verification do not read these settings.
 */

export type ConsentMode = "cookieless" | "ask";
export type InternalMode = "drop" | "flag";

export type AnalyticsSettings = {
  /** Record visits and events at all. Records-based reports work either way. */
  enabled: boolean;
  /** IANA zone the dashboard reports in. */
  timezone: string;
  /** Range the dashboard opens with. */
  defaultRange: Exclude<RangePreset, "custom">;
  /** Treat visits by signed-in administrators as internal. */
  excludeAdmins: boolean;
  /** Addresses (or IPv4 ranges) whose visits are internal. */
  internalIps: string[];
  /** Internal visits: not stored at all, or stored with a flag and hidden by default. */
  internalMode: InternalMode;
  /** Events and visits older than this many days are deleted. */
  retentionDays: number;
  /**
   * cookieless: nothing is stored on the visitor's device; visitors are
   * estimated per day. ask: a banner asks to remember the browser with a
   * random id; only then can returning visitors be recognised.
   */
  consentMode: ConsentMode;
  /** Administrators may download CSV files. */
  exportEnabled: boolean;
  /** CSV exports of the account table include email addresses. */
  exportIncludesEmail: boolean;
};

export const DEFAULT_SETTINGS: AnalyticsSettings = {
  enabled: true,
  timezone: "Asia/Kolkata",
  defaultRange: "last_30_days",
  excludeAdmins: true,
  internalIps: [],
  internalMode: "drop",
  retentionDays: 395,
  consentMode: "cookieless",
  exportEnabled: true,
  exportIncludesEmail: false,
};

export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 730;
export const MAX_INTERNAL_IPS = 25;

const KEY = "analytics.settings";

type Meta = { updatedAt: number | null; updatedBy: string | null };

export function analyticsSettingsWithMeta(): AnalyticsSettings & Meta {
  const row = one<{ value: string; updated_at: number; updated_by: string | null }>(
    "SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?",
    [KEY],
  );
  let stored: Partial<AnalyticsSettings> = {};
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<AnalyticsSettings>;
    } catch {
      stored = {};
    }
  }
  // Re-validate on read, so a hand-edited or older value can never put the
  // app into a state the form would have refused.
  const merged = validateSettings({ ...DEFAULT_SETTINGS, ...stored });
  return {
    ...(merged.ok ? merged.settings : DEFAULT_SETTINGS),
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

export function analyticsSettings(): AnalyticsSettings {
  const { updatedAt: _a, updatedBy: _b, ...settings } = analyticsSettingsWithMeta();
  return settings;
}

export type SettingsValidation =
  | { ok: true; settings: AnalyticsSettings }
  | { ok: false; fields: Record<string, string> };

/** Every field is checked; unknown fields are ignored. */
export function validateSettings(raw: Record<string, unknown>): SettingsValidation {
  const fields: Record<string, string> = {};
  const bool = (key: keyof AnalyticsSettings) => {
    const value = raw[key];
    if (typeof value !== "boolean") fields[key] = "Must be on or off.";
    return value === true;
  };

  const enabled = bool("enabled");
  const excludeAdmins = bool("excludeAdmins");
  const exportEnabled = bool("exportEnabled");
  const exportIncludesEmail = bool("exportIncludesEmail");

  const timezone = typeof raw.timezone === "string" ? raw.timezone.trim() : "";
  if (!isValidTimeZone(timezone)) fields.timezone = "Choose a valid timezone, like Asia/Kolkata.";

  const defaultRange = raw.defaultRange;
  if (typeof defaultRange !== "string" || defaultRange === "custom" || !(RANGE_PRESETS as readonly string[]).includes(defaultRange)) {
    fields.defaultRange = "Choose one of the listed ranges.";
  }

  const internalMode = raw.internalMode;
  if (internalMode !== "drop" && internalMode !== "flag") fields.internalMode = "Choose how internal visits are handled.";

  const consentMode = raw.consentMode;
  if (consentMode !== "cookieless" && consentMode !== "ask") fields.consentMode = "Choose a privacy mode.";

  const retention = raw.retentionDays;
  if (typeof retention !== "number" || !Number.isInteger(retention) || retention < MIN_RETENTION_DAYS || retention > MAX_RETENTION_DAYS) {
    fields.retentionDays = `From ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} days.`;
  }

  let internalIps: string[] = [];
  if (!Array.isArray(raw.internalIps) || raw.internalIps.some((ip) => typeof ip !== "string")) {
    fields.internalIps = "Enter one address per line.";
  } else {
    internalIps = [...new Set((raw.internalIps as string[]).map((ip) => ip.trim()).filter(Boolean))];
    const bad = internalIps.find((ip) => !isValidIpRule(ip));
    if (bad) fields.internalIps = `"${bad.slice(0, 45)}" isn't an IP address or IPv4 range (like 203.0.113.0/24).`;
    else if (internalIps.length > MAX_INTERNAL_IPS) fields.internalIps = `At most ${MAX_INTERNAL_IPS} entries.`;
  }

  if (Object.keys(fields).length) return { ok: false, fields };
  return {
    ok: true,
    settings: {
      enabled,
      timezone,
      defaultRange: defaultRange as AnalyticsSettings["defaultRange"],
      excludeAdmins,
      internalIps,
      internalMode: internalMode as InternalMode,
      retentionDays: retention as number,
      consentMode: consentMode as ConsentMode,
      exportEnabled,
      exportIncludesEmail,
    },
  };
}

export function saveAnalyticsSettings(settings: AnalyticsSettings, by: string, now = Date.now()): void {
  run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [KEY, JSON.stringify(settings), now, by],
  );
}
