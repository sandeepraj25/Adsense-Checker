import { requestContext, trackServerEvent } from "@/lib/analytics/store";
import { verifyCode } from "@/lib/auth/email-verification";
import { postLoginPath } from "@/lib/auth/redirect";
import { startSession } from "@/lib/auth/session";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Step 2 of sign-up: confirm the emailed code.
 *
 * Which sign-up is being confirmed comes from the httpOnly verification
 * cookie, never from the body — the body carries only the six digits.
 * The per-code attempt limit (5) lives in the database with the code; the
 * IP bucket here additionally stops one client cycling through many
 * pending sign-ups.
 *
 * The account and its session are created only after the code checks out.
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  const limit = rateLimit(`verify:ip:${ip}`, 30, 15 * 60 * 1000);
  if (!limit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const outcome = await verifyCode(body.code);

  if (!outcome.ok) {
    return jsonError(outcome.code, outcome.message, {
      extra: outcome.attemptsLeft !== undefined ? { attemptsLeft: outcome.attemptsLeft } : undefined,
    });
  }

  await startSession(outcome.user.id, {
    userAgent: request.headers.get("user-agent"),
    ip,
  });

  trackServerEvent("email_verified", {
    key: `verified:${outcome.user.id}`,
    userId: outcome.user.id,
    context: requestContext(request, ip),
  });

  return jsonOk({
    userId: outcome.user.id,
    redirectTo: postLoginPath(outcome.user, outcome.nextPath),
  });
}
