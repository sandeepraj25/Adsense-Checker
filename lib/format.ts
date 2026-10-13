/**
 * Date + number presentation. Every format here pins the timezone and
 * locale so a value rendered on the server matches the same value
 * rendered on the client — otherwise React hydration flags a mismatch
 * for anyone not sitting in the server's timezone.
 *
 * IST is the right anchor: the product prices in INR and bills through
 * Razorpay, so invoices and expiry dates should read in the same
 * timezone the customer's bank statement does.
 */

const TZ = "Asia/Kolkata";
const LOCALE = "en-IN";

const dateFmt = new Intl.DateTimeFormat(LOCALE, {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: TZ,
});

const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  timeZone: TZ,
});

const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  timeZone: TZ,
});

/** "04 Mar 2026" */
export function formatDate(ms: number): string {
  return dateFmt.format(new Date(ms));
}

/** "04 Mar 2026, 09:14 pm" */
export function formatDateTime(ms: number): string {
  return dateTimeFmt.format(new Date(ms));
}

/** "09:14 pm" */
export function formatTime(ms: number): string {
  return timeFmt.format(new Date(ms));
}

const DAY_MS = 86_400_000;

/**
 * Coarse relative age for lists — "Just now", "3 hours ago", "Yesterday",
 * then an absolute date once it stops being useful to count.
 *
 * Takes `now` explicitly so callers can pass a single timestamp for a
 * whole list and keep server and client output identical.
 */
export function formatAge(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 60_000) return "Just now";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(diff / DAY_MS);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;

  return formatDate(ms);
}

/** "25 checks", "1 check" */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Milliseconds as a short human duration: "1.4s", "820ms", "2m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
