import { optionalUser } from "@/lib/auth/guard";
import { startAudit } from "@/lib/audit-service";
import { jsonError, jsonOk, readJson, str } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
/**
 * The request only sets the scan up (plan, limits, quota) and answers with
 * the report id; the scan runs as a background job (lib/scans/jobs.ts) and
 * the page polls /api/reports/[id] until it is complete or failed.
 */
export const maxDuration = 30;

export async function POST(request: Request) {
  const user = await optionalUser();
  if (!user) {
    return jsonError("UNAUTHENTICATED", "Log in to run an audit.");
  }

  // A ceiling above the plan quota, to stop a script hammering third-party
  // sites through us even on a large plan.
  const limit = rateLimit(`analysis:${user.id}`, 30, 60 * 60 * 1000);
  if (!limit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `That is a lot of audits at once. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
    );
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const url = str(body.url).trim();
  if (!url) return jsonError("INVALID_URL", "Enter a website address.");

  const result = await startAudit(user, url);
  if (!result.ok) return jsonError(result.code, result.message);

  return jsonOk(
    {
      reportId: result.report.id,
      ref: result.report.ref,
      state: result.report.state,
      queued: Boolean(result.queued),
      score: result.report.score,
      verdict: result.report.verdict,
      demo: result.demo,
    },
    result.queued ? 202 : 200,
  );
}
