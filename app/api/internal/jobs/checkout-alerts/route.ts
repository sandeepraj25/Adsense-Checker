import { runAlertJob } from "@/lib/alerts/job";
import { jsonError } from "@/lib/http";
import { authorizeScheduler, runForScheduler } from "@/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The scheduled entry point for alerts: finds abandoned checkouts and
 * sends due alerts. Meant for a scheduler (e.g. a Render Cron Job) to call
 * every few minutes:
 *
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        https://your-site/api/internal/jobs/checkout-alerts
 *
 * Only a request carrying CRON_SECRET runs it (lib/scheduler.ts). Without
 * the variable set the endpoint refuses everything, so it can never be
 * open by accident. Running it more often than needed is harmless — every
 * claim and every alert is de-duplicated in the database.
 */
export async function POST(request: Request) {
  const refused = authorizeScheduler(request, "checkout-alerts");
  if (refused) return refused;
  return runForScheduler(
    "checkout-alerts",
    () => runAlertJob(Date.now(), "scheduler"),
    (result) => ({ summary: result.summary, abandoned: result.abandoned, delivered: result.delivered }),
  );
}

export async function GET() {
  return jsonError("VALIDATION_ERROR", "Use POST with the scheduler's bearer token.", { status: 405 });
}
