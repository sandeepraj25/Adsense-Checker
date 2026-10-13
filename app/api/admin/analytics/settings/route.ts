import { recordAdminAction } from "@/lib/db/admin";
import { requireAdminApi } from "@/lib/auth/guard";
import { analyticsSettingsWithMeta, saveAnalyticsSettings, validateSettings } from "@/lib/analytics/settings";
import { trackingStatus } from "@/lib/analytics/store";
import { jsonError, jsonOk, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  return jsonOk({ settings: analyticsSettingsWithMeta(), status: trackingStatus() });
}

/**
 * PATCH the analytics settings. Every field is required and validated
 * (the form always sends all of them); the change is audit-logged.
 */
export async function PATCH(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  const result = validateSettings(body);
  if (!result.ok) return jsonError("VALIDATION_ERROR", "Some settings need fixing.", { fields: result.fields });

  const before = analyticsSettingsWithMeta();
  saveAnalyticsSettings(result.settings, guard.admin.email);
  const changed = (Object.keys(result.settings) as (keyof typeof result.settings)[]).filter(
    (key) => JSON.stringify(result.settings[key]) !== JSON.stringify(before[key]),
  );
  recordAdminAction({
    admin: guard.admin,
    action: "analytics.settings_updated",
    targetType: "system",
    targetLabel: "Website analytics",
    detail: changed.length ? `changed: ${changed.join(", ")}` : "no changes",
  });
  return jsonOk({ settings: result.settings });
}
