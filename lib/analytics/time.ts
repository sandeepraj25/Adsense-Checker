/**
 * Calendar arithmetic in the reporting timezone, without a date library.
 *
 * Timestamps are stored as UTC milliseconds everywhere in this app. A
 * report for "yesterday in Asia/Kolkata" needs the UTC instants at which
 * that local day began and ended; `localMidnight` finds them using the
 * platform's own timezone database (Intl), so DST changes in zones that
 * have them are handled the same way the operating system handles them.
 */

export const DAY_MS = 86_400_000;

export const RANGE_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "this_month",
  "last_month",
  "custom",
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const PRESET_LABEL: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom range",
};

export const MAX_RANGE_DAYS = 366;

export type Interval = "day" | "week" | "month";

/** YYYY-MM-DD as plain numbers. */
export type LocalDate = { y: number; m: number; d: number };

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in `tz`. */
function wallClock(instant: number, tz: string) {
  const out: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(instant))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, mi: out.minute, s: out.second };
}

/** Offset of `tz` from UTC at `instant`, in ms (IST is +19 800 000). */
export function tzOffset(instant: number, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function localDateOf(instant: number, tz: string): LocalDate {
  const w = wallClock(instant, tz);
  return { y: w.y, m: w.m, d: w.d };
}

/** The UTC instant at which local date `date` begins in `tz`. */
export function localMidnight(date: LocalDate, tz: string): number {
  const naive = Date.UTC(date.y, date.m - 1, date.d);
  let guess = naive - tzOffset(naive, tz);
  // Twice is enough to settle across a DST transition.
  for (let i = 0; i < 2; i++) {
    const next = naive - tzOffset(guess, tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function addMonths(date: LocalDate, months: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1 + months, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: 1 };
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

export function formatLocalDate(date: LocalDate): string {
  return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}

export function parseLocalDate(raw: unknown): LocalDate | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== m || t.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return { y, m, d };
}

export type ResolvedRange = {
  preset: RangePreset;
  label: string;
  tz: string;
  /** Inclusive local dates, for display and for the custom inputs. */
  fromDate: LocalDate;
  toDate: LocalDate;
  /** UTC instants: [start, end). `end` is clamped to now for ranges that include today. */
  start: number;
  end: number;
  /** True when the range runs into the future and was cut at "now". */
  partial: boolean;
  /** The equivalent period immediately before, cut to the same elapsed length. */
  previous: { start: number; end: number; fromDate: LocalDate; toDate: LocalDate };
  days: number;
};

export type RangeError = { error: string };

/**
 * Turns a preset (or a custom from/to) into UTC instants in `tz`.
 *
 * The comparison period has the same number of local days and ends just
 * before this one starts. Month presets compare with the previous
 * calendar month instead. When the range includes today, both periods are
 * cut to the same elapsed time — today until 3 pm is compared with
 * yesterday until 3 pm, not with all of yesterday.
 */
export function resolveRange(input: {
  preset: string | null | undefined;
  from?: string | null;
  to?: string | null;
  tz: string;
  now: number;
  fallback?: RangePreset;
}): ResolvedRange | RangeError {
  const tz = input.tz;
  const preset: RangePreset = (RANGE_PRESETS as readonly string[]).includes(input.preset ?? "")
    ? (input.preset as RangePreset)
    : (input.fallback ?? "last_30_days");
  const today = localDateOf(input.now, tz);

  let fromDate: LocalDate;
  let toDate: LocalDate;
  let monthly = false;

  switch (preset) {
    case "today":
      fromDate = toDate = today;
      break;
    case "yesterday":
      fromDate = toDate = addDays(today, -1);
      break;
    case "last_7_days":
      fromDate = addDays(today, -6);
      toDate = today;
      break;
    case "last_30_days":
      fromDate = addDays(today, -29);
      toDate = today;
      break;
    case "last_90_days":
      fromDate = addDays(today, -89);
      toDate = today;
      break;
    case "this_month":
      fromDate = { y: today.y, m: today.m, d: 1 };
      toDate = today;
      monthly = true;
      break;
    case "last_month": {
      fromDate = addMonths(today, -1);
      toDate = addDays({ y: today.y, m: today.m, d: 1 }, -1);
      monthly = true;
      break;
    }
    case "custom": {
      const from = parseLocalDate(input.from);
      const to = parseLocalDate(input.to);
      if (!from || !to) return { error: "Choose a start and an end date." };
      if (daysBetween(from, to) < 0) return { error: "The start date must be on or before the end date." };
      if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return { error: `A range can cover at most ${MAX_RANGE_DAYS} days.` };
      if (daysBetween(today, from) > 0) return { error: "The range starts in the future." };
      fromDate = from;
      toDate = to;
      break;
    }
  }

  const days = daysBetween(fromDate, toDate) + 1;
  const start = localMidnight(fromDate, tz);
  const fullEnd = localMidnight(addDays(toDate, 1), tz);
  const end = Math.min(fullEnd, input.now);
  const elapsed = end - start;

  let prevFrom: LocalDate;
  let prevTo: LocalDate;
  if (monthly) {
    prevFrom = addMonths(fromDate, -1);
    prevTo = addDays(fromDate, -1);
  } else {
    prevFrom = addDays(fromDate, -days);
    prevTo = addDays(fromDate, -1);
  }
  const prevStart = localMidnight(prevFrom, tz);
  const prevFullEnd = localMidnight(addDays(prevTo, 1), tz);
  const prevEnd = Math.min(prevFullEnd, prevStart + elapsed);

  return {
    preset,
    label: preset === "custom" ? `${formatLocalDate(fromDate)} → ${formatLocalDate(toDate)}` : PRESET_LABEL[preset],
    tz,
    fromDate,
    toDate,
    start,
    end,
    partial: fullEnd > input.now,
    previous: { start: prevStart, end: prevEnd, fromDate: prevFrom, toDate: prevTo },
    days,
  };
}

export type Bucket = { key: string; label: string; start: number; end: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Consecutive local days, ISO weeks (Monday start) or calendar months
 * covering the range. The first and last buckets are trimmed to the range.
 */
export function buckets(range: Pick<ResolvedRange, "fromDate" | "toDate" | "start" | "end" | "tz">, interval: Interval): Bucket[] {
  const out: Bucket[] = [];
  const tz = range.tz;
  let cursor = range.fromDate;
  if (interval === "week") {
    const dow = new Date(Date.UTC(cursor.y, cursor.m - 1, cursor.d)).getUTCDay(); // 0 = Sunday
    cursor = addDays(cursor, -((dow + 6) % 7));
  } else if (interval === "month") {
    cursor = { y: cursor.y, m: cursor.m, d: 1 };
  }
  for (let guard = 0; guard < 400; guard++) {
    const next = interval === "day" ? addDays(cursor, 1) : interval === "week" ? addDays(cursor, 7) : addMonths(cursor, 1);
    const s = Math.max(localMidnight(cursor, tz), range.start);
    const e = Math.min(localMidnight(next, tz), range.end);
    if (s >= range.end) break;
    if (e > s) {
      const label =
        interval === "month"
          ? `${MONTHS[cursor.m - 1]} ${cursor.y}`
          : `${String(cursor.d).padStart(2, "0")} ${MONTHS[cursor.m - 1]}${interval === "week" ? " wk" : ""}`;
      out.push({ key: formatLocalDate(cursor), label, start: s, end: e });
    }
    cursor = next;
  }
  return out;
}

/** "GMT+05:30" for the heading. */
export function tzOffsetLabel(tz: string, at: number): string {
  const minutes = Math.round(tzOffset(at, tz) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Percentage change, or null when there is no base to compare with. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
