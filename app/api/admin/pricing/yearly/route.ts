import { requireAdminApi } from "@/lib/auth/guard";
import { setYearlyBillingEnabled, yearlyBillingSetting } from "@/lib/billing/yearly-settings";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";

export const runtime = "nodejs";

/**
 * The site-wide "Enable yearly billing" switch. Body: { enabled: boolean }.
 * Turning it off returns the site to monthly-only immediately; yearly
 * subscriptions already bought keep their twelve months.
 */
export async function PATCH(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const body = await readJson(request);
  if (!body || typeof body.enabled !== "boolean") return jsonError("VALIDATION_ERROR", "Send enabled: true or false.");
  try {
    const before = yearlyBillingSetting().enabled;
    if (before !== body.enabled) {
      setYearlyBillingEnabled(body.enabled, guard.admin.email);
      recordAdminAction({
        admin: { id: guard.admin.id, email: guard.admin.email },
        action: "billing.yearly_toggled",
        targetType: "system",
        targetLabel: "Yearly billing",
        detail: body.enabled ? "Yearly billing turned on" : "Yearly billing turned off",
      });
    }
    return jsonOk({ enabled: body.enabled });
  } catch (error) {
    return jsonServerError("admin/pricing/yearly", error);
  }
}
