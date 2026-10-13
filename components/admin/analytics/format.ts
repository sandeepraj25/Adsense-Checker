import type { KpiFormat } from "@/lib/analytics/report";

const intFmt = new Intl.NumberFormat("en-IN");

export function fmtInt(n: number): string {
  return intFmt.format(Math.round(n));
}

export function fmtPct(ratio: number | null, digits = 1): string {
  return ratio === null ? "—" : `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtValue(value: number | null, format: KpiFormat): string {
  if (value === null) return "—";
  switch (format) {
    case "int":
      return fmtInt(value);
    case "pct":
      return fmtPct(value);
    case "duration":
      return fmtDuration(value);
    case "decimal":
      return value.toFixed(2);
  }
}

/** Signed change for a KPI. Rates compare in percentage points. */
export function change(current: number | null, previous: number | null, format: KpiFormat): { text: string; direction: "up" | "down" | "flat" | "none" } {
  if (current === null || previous === null) return { text: "No comparison", direction: "none" };
  if (format === "pct") {
    const pts = (current - previous) * 100;
    if (Math.abs(pts) < 0.05) return { text: "0.0 pts", direction: "flat" };
    return { text: `${pts > 0 ? "+" : "−"}${Math.abs(pts).toFixed(1)} pts`, direction: pts > 0 ? "up" : "down" };
  }
  if (previous === 0) return current === 0 ? { text: "0%", direction: "flat" } : { text: "New", direction: "up" };
  const p = ((current - previous) / previous) * 100;
  if (Math.abs(p) < 0.05) return { text: "0%", direction: "flat" };
  return { text: `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`, direction: p > 0 ? "up" : "down" };
}

const tzFormatters = new Map<string, Intl.DateTimeFormat>();

/** A timestamp in the reporting timezone: "04 Mar 2026" or "04 Mar 2026, 09:14 pm". */
export function fmtDateIn(ms: number, tz: string, withTime = false): string {
  const key = `${tz}|${withTime}`;
  let f = tzFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: true } : {}),
      timeZone: tz,
    });
    tzFormatters.set(key, f);
  }
  return f.format(new Date(ms));
}
