import { runAlertJob } from "@/lib/alerts/job";
import { jsonError, jsonOk, jsonServerError } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { safeEqual } from "@/lib/secrets";

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
 * Only a request carrying CRON_SECRET runs it. Without the variable set
 * the endpoint refuses everything, so it can never be open by accident.
 * Running it more often than needed is harmless — every claim and every
 * alert is de-duplicated in the database.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    return jsonError("FORBIDDEN", "Scheduled jobs are not configured on this server (CRON_SECRET is missing or too short).", { status: 503 });
  }
  if (!rateLimit(`cron:${clientIp(request)}`, 30, 60_000).ok) {
    return jsonError("RATE_LIMITED", "Too many requests.");
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !safeEqual(token, secret)) {
    return jsonError("UNAUTHENTICATED", "Not allowed.", { status: 401 });
  }
  try {
    const result = await runAlertJob();
    return jsonOk({ summary: result.summary, abandoned: result.abandoned, delivered: result.delivered });
  } catch (error) {
    return jsonServerError("jobs/checkout-alerts", error);
  }
}

export async function GET() {
  return jsonError("VALIDATION_ERROR", "Use POST with the scheduler's bearer token.", { status: 405 });
}
