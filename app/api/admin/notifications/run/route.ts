import { runAlertJob } from "@/lib/alerts/job";
import { requireAdminApi } from "@/lib/auth/guard";
import { jsonOk, jsonServerError } from "@/lib/http";

export const runtime = "nodejs";

/** "Run now" from the admin page: the same job the scheduler runs. */
export async function POST() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  try {
    const result = await runAlertJob(Date.now(), "admin");
    return jsonOk({ summary: result.summary });
  } catch (error) {
    return jsonServerError("admin/notifications/run", error);
  }
}
