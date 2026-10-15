import { jsonError } from "@/lib/http";
import { authorizeScheduler, runForScheduler } from "@/lib/scheduler";
import { runScheduledRescans } from "@/lib/schedules/job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The scheduled entry point for weekly rescans: runs up to three due
 * rescans and sends queued change emails. Meant for a scheduler to call
 * every few minutes:
 *
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        https://your-site/api/internal/jobs/rescans
 *
 * Only a request carrying CRON_SECRET runs it (lib/scheduler.ts).
 * Schedules are claimed in the database, so overlapping calls never run a
 * rescan twice.
 */
export async function POST(request: Request) {
  const refused = authorizeScheduler(request, "rescans");
  if (refused) return refused;
  return runForScheduler(
    "rescans",
    () => runScheduledRescans(),
    (result) => ({ summary: result.summary, tally: result.tally, emails: result.emails }),
  );
}

export async function GET() {
  return jsonError("VALIDATION_ERROR", "Use POST with the scheduler's bearer token.", { status: 405 });
}
