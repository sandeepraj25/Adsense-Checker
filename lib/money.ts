/**
 * Money helpers.
 *
 * Amounts move through the system as integers in the *minor unit* of
 * their currency — paise for INR, cents for USD. The database columns are
 * still called `amount_paise` (renaming them would touch every table for
 * no gain); read them as "minor units of the row's `currency`".
 *
 * No float ever carries money here. Admin input is parsed from its
 * decimal string with integer arithmetic, and gateway amounts are
 * rendered with integer division, so ₹399.99 is always 39999 and never
 * 39998.999…
 */

export const CURRENCIES = ["INR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "INR";

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** Case-insensitive, for query strings like `?currency=usd`. */
export function parseCurrency(value: unknown): Currency | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return isCurrency(upper) ? upper : null;
}

export const CURRENCY_META: Record<Currency, { symbol: string; locale: string; name: string }> = {
  INR: { symbol: "₹", locale: "en-IN", name: "Indian rupees" },
  USD: { symbol: "$", locale: "en-US", name: "US dollars" },
};

/** Both supported currencies have two decimal places. */
const MINOR_DIGITS = 2;

/**
 * "399", "399.5", "399.50", "1,299" → minor units. Null for anything else:
 * negatives, more than two decimals, exponents, letters, empty.
 */
export function parseMajorToMinor(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    raw = String(raw);
  }
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/,/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number.parseInt(match[1], 10);
  const fraction = Number.parseInt((match[2] ?? "").padEnd(MINOR_DIGITS, "0"), 10);
  return whole * 100 + fraction;
}

/** 39999 → "399.99", 500 → "5.00". Integer maths only. */
export function minorToDecimalString(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new Error(`Not a money amount: ${minor}`);
  }
  const whole = Math.floor(minor / 100);
  const fraction = (minor % 100).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

/** 39999 → "399.99", 39900 → "399" — for pre-filling an edit field. */
export function minorToInput(minor: number): string {
  const text = minorToDecimalString(minor);
  return text.endsWith(".00") ? text.slice(0, -3) : text;
}

/** "₹399", "$5.99", "₹2,499" — no trailing .00 on whole amounts. */
export function formatMoney(minor: number, currency: string): string {
  const code = isCurrency(currency) ? currency : DEFAULT_CURRENCY;
  const hasFraction = minor % 100 !== 0;
  return new Intl.NumberFormat(CURRENCY_META[code].locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  }).format(minor / 100);
}

/** For invoices and payment tables, where two decimals always show. */
export function formatMoneyExact(minor: number, currency: string): string {
  const code = isCurrency(currency) ? currency : DEFAULT_CURRENCY;
  return new Intl.NumberFormat(CURRENCY_META[code].locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** "₹399", "₹2,499". Kept for INR-only call sites (plan catalogue copy). */
export function formatINR(paise: number): string {
  return formatMoney(paise, "INR");
}

/** For invoices, where we always want two decimal places. */
export function formatINRExact(paise: number): string {
  return formatMoneyExact(paise, "INR");
}
