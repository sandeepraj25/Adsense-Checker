import { jsonError, readJson } from "@/lib/http";
import { runMlJob } from "@/lib/ml/job";
import { authorizeScheduler, runForScheduler } from "@/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The scheduled entry point for the prediction system: accepts deferred
 * feedback, sends due feedback emails, and retrains when the nightly run
 * is due. Meant for a scheduler to call every few minutes, like the
 * checkout-alerts job:
 *
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        https://your-site/api/internal/jobs/ml
 *
 * Send {"train": true} to train now regardless of the schedule. Only a
 * request carrying CRON_SECRET runs it (lib/scheduler.ts); without the
 * variable the endpoint refuses everything.
 */
export async function POST(request: Request) {
  const refused = authorizeScheduler(request, "ml");
  if (refused) return refused;
  const body = (await readJson(request)) ?? {};
  return runForScheduler(
    "ml",
    () => runMlJob({ forceTraining: body.train === true, trigger: "cron" }),
    (result) => ({ summary: result.summary, training: result.training }),
  );
}

export async function GET() {
  return jsonError("VALIDATION_ERROR", "Use POST with the scheduler's bearer token.", { status: 405 });
}
