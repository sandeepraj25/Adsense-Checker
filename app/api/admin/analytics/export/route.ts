import { recordAdminAction } from "@/lib/db/admin";
import { requireAdminApi } from "@/lib/auth/guard";
import { buildExport, EXPORTS, isExportName } from "@/lib/analytics/exports";
import { parseReportQuery } from "@/lib/analytics/report";
import { analyticsSettings } from "@/lib/analytics/settings";
import { jsonError, jsonServerError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/analytics/export?dataset=pages&range=…
 *
 * A CSV of one report, for administrators, when exports are allowed in
 * Settings. Each download is written to the admin audit log.
 */
export async function GET(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;

  const settings = analyticsSettings();
  if (!settings.exportEnabled) return jsonError("FORBIDDEN", "CSV export is turned off in Website analytics → Settings.");

  const url = new URL(request.url);
  const dataset = url.searchParams.get("dataset");
  if (!isExportName(dataset)) {
    return jsonError("VALIDATION_ERROR", "Choose a report to export.", { fields: { dataset: Object.keys(EXPORTS).join(", ") } });
  }
  const params = Object.fromEntries(url.searchParams.entries());
  try {
    const query = parseReportQuery(params, settings);
    if (query.rangeError && params.range === "custom") return jsonError("VALIDATION_ERROR", query.rangeError);
    const { filename, csv } = buildExport(dataset, query, settings);
    recordAdminAction({
      admin: guard.admin,
      action: "analytics.exported",
      targetType: "system",
      targetLabel: EXPORTS[dataset],
      detail: `${dataset} · ${query.range.label}${dataset === "users" && settings.exportIncludesEmail ? " · with emails" : ""}`,
    });
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return jsonServerError("admin/analytics/export", error);
  }
}
