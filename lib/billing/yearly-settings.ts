import { one, run } from "@/lib/db";

/**
 * The site-wide "Enable yearly billing" switch (Admin → Pricing). Off
 * until an administrator turns it on; with it off the site behaves
 * exactly as before — monthly only — whatever yearly prices are saved.
 */

const KEY = "billing.yearly_enabled";

export function yearlyBillingSetting(): { enabled: boolean; updatedAt: number | null; updatedBy: string | null } {
  try {
    const row = one<{ value: string; updated_at: number; updated_by: string | null }>(
      "SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?",
      [KEY],
    );
    return { enabled: row?.value === "1", updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
  } catch {
    return { enabled: false, updatedAt: null, updatedBy: null };
  }
}

export function yearlyBillingEnabled(): boolean {
  return yearlyBillingSetting().enabled;
}

export function setYearlyBillingEnabled(enabled: boolean, by: string, now = Date.now()): void {
  run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [KEY, enabled ? "1" : "0", now, by],
  );
}
