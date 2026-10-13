import { one, run } from "@/lib/db";
import { formatMoney, parseCurrency, type Currency } from "@/lib/money";
import { planPrice, type Plan } from "@/lib/plans";

/**
 * The one currency the whole customer-facing site shows and charges in,
 * chosen by an administrator (Admin → Website currency).
 *
 * Stored in `app_settings`, so it survives restarts and needs no deploy to
 * change. Every page that shows a catalogue price, and the checkout route
 * that opens an order, reads it from here — the browser never chooses.
 * Each plan keeps a separate price per currency; switching the site
 * currency selects the other configured price and never converts one into
 * the other. Payments already made keep the currency they were made in.
 */

const KEY = "site.currency";

/** Used when nothing valid has been saved yet. */
export const DEFAULT_SITE_CURRENCY: Currency = "USD";

export function siteCurrencySetting(): { currency: Currency; saved: boolean; updatedAt: number | null; updatedBy: string | null } {
  try {
    const row = one<{ value: string; updated_at: number; updated_by: string | null }>(
      "SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?",
      [KEY],
    );
    const parsed = row ? parseCurrency(row.value) : null;
    return parsed
      ? { currency: parsed, saved: true, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null }
      : { currency: DEFAULT_SITE_CURRENCY, saved: false, updatedAt: null, updatedBy: null };
  } catch {
    return { currency: DEFAULT_SITE_CURRENCY, saved: false, updatedAt: null, updatedBy: null };
  }
}

export function siteCurrency(): Currency {
  return siteCurrencySetting().currency;
}

/** Callers validate with parseCurrency first; this refuses anything else anyway. */
export function setSiteCurrency(currency: Currency, by: string, now = Date.now()): void {
  if (!parseCurrency(currency)) throw new Error("Unsupported currency");
  run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [KEY, currency, now, by],
  );
}

/** "₹399/month", or null when the plan has no price in the site currency. */
export function sitePriceLabel(plan: Pick<Plan, "id" | "amountPaise" | "usdAmountCents">, currency = siteCurrency()): string | null {
  const amount = planPrice(plan, currency);
  return amount === null ? null : formatMoney(amount, currency);
}
