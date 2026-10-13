import { requireAdminApi } from "@/lib/auth/guard";
import { parseReportQuery } from "@/lib/analytics/report";
import { sectionData } from "@/lib/analytics/sections";
import { analyticsSettings } from "@/lib/analytics/settings";
import { jsonError, jsonOk, jsonServerError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/analytics?tab=overview&range=last_30_days[&from&to&interval&internal=1]
 *
 * One dashboard tab as JSON, aggregated on the server. Administrators
 * only — checked here, not just by hiding the page.
 */
export async function GET(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  try {
    const query = parseReportQuery(params, analyticsSettings());
    if (query.rangeError && params.range === "custom") return jsonError("VALIDATION_ERROR", query.rangeError, { fields: { range: query.rangeError } });
    return jsonOk({
      tab: query.tab,
      range: { preset: query.range.preset, label: query.range.label, timezone: query.range.tz, start: query.range.start, end: query.range.end, previous: query.range.previous },
      interval: query.interval,
      data: sectionData(query.tab, query),
    });
  } catch (error) {
    return jsonServerError("admin/analytics", error);
  }
}
