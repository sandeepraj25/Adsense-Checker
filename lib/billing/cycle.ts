/**
 * Billing cycles: monthly and yearly. Pure and browser-safe — no database,
 * so the pricing cards, the checkout page and the server all compute the
 * same numbers the same way.
 *
 * Calendar months are counted in India Standard Time (UTC+05:30, no
 * daylight saving), the zone every date in the product is shown in, and
 * always from the original anchor rather than from the previous period —
 * so a plan bought on 31 January resets on 28/29 February, then 31 March,
 * and never drifts to the 28th. Twelve months from 29 February is
 * 28 February of the next year.
 */

export const BILLING_CYCLES = ["monthly", "yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export function isBillingCycle(value: unknown): value is BillingCycle {
  return value === "monthly" || value === "yearly";
}

/** Old rows and missing values are monthly — that is all there was before. */
export function parseBillingCycle(value: unknown): BillingCycle {
  return value === "yearly" ? "yearly" : "monthly";
}

export const CYCLE_MONTHS: Record<BillingCycle, number> = { monthly: 1, yearly: 12 };

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `anchor` plus `months` calendar months, at the same IST time of day. The
 * day of month is clamped to the target month's length (31 Jan + 1 month
 * = 28 or 29 Feb).
 */
export function addCalendarMonths(anchor: number, months: number): number {
  const local = new Date(anchor + IST_OFFSET_MS);
  const total = local.getUTCMonth() + months;
  const year = local.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(local.getUTCDate(), daysInMonth(year, month));
  const shifted = Date.UTC(
    year,
    month,
    day,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return shifted - IST_OFFSET_MS;
}

/** When a period bought at `start` for this cycle ends. */
export function periodEnd(start: number, cycle: BillingCycle, periods = 1): number {
  return addCalendarMonths(start, CYCLE_MONTHS[cycle] * Math.max(1, Math.floor(periods)));
}

/**
 * The yearly discount against paying monthly for twelve months, in whole
 * percent, rounded down so it is never overstated:
 *
 *   discount = (1 − yearly ÷ (monthly × 12)) × 100
 *
 * Null when either price is missing, not a positive whole number of minor
 * units, or when yearly is not cheaper (no discount to advertise).
 */
export function yearlyDiscountPercent(monthlyMinor: number | null | undefined, yearlyMinor: number | null | undefined): number | null {
  if (typeof monthlyMinor !== "number" || typeof yearlyMinor !== "number") return null;
  if (!Number.isInteger(monthlyMinor) || !Number.isInteger(yearlyMinor)) return null;
  if (monthlyMinor <= 0 || yearlyMinor <= 0) return null;
  const twelve = monthlyMinor * 12;
  if (yearlyMinor >= twelve) return null;
  // Integer maths: floor((twelve − yearly) × 100 ÷ twelve).
  const percent = Math.floor(((twelve - yearlyMinor) * 100) / twelve);
  return percent >= 1 ? percent : null;
}

/** What one month costs on the yearly price, rounded to the nearest minor unit (for display). */
export function monthlyEquivalent(yearlyMinor: number): number {
  return Math.round(yearlyMinor / 12);
}

export function cycleLabel(cycle: BillingCycle): string {
  return cycle === "yearly" ? "Yearly" : "Monthly";
}

export function cyclePeriodLabel(cycle: BillingCycle): string {
  return cycle === "yearly" ? "year" : "month";
}
