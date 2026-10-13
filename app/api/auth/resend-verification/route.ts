import { currentPending, sendFreshCode } from "@/lib/auth/email-verification";
import { jsonError, jsonOk } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { requestOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

/**
 * Sends a new code for the sign-up this browser started. The new code
 * replaces the old one, which stops working immediately.
 *
 * Three limits: a 60-second cooldown per sign-up (in the database), and
 * hourly caps per address and per IP here.
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  const ipLimit = rateLimit(`resend:ip:${ip}`, 20, 60 * 60 * 1000);
  if (!ipLimit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many codes requested. Try again in ${Math.ceil(ipLimit.retryAfterSeconds / 60)} minutes.`,
      { extra: { retryAfterSeconds: ipLimit.retryAfterSeconds } },
    );
  }

  const pending = await currentPending();
  if (!pending) {
    return jsonError(
      "VERIFICATION_NOT_FOUND",
      "This verification has ended. Sign up again or log in to get a new code.",
    );
  }

  const emailLimit = rateLimit(`resend:email:${pending.email}`, 5, 60 * 60 * 1000);
  if (!emailLimit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many codes were requested for this address. Try again in ${Math.ceil(emailLimit.retryAfterSeconds / 60)} minutes.`,
      { extra: { retryAfterSeconds: emailLimit.retryAfterSeconds } },
    );
  }

  const origin = requestOrigin(request.headers, request.url);
  const sent = await sendFreshCode(pending, `${origin}/login`);

  if (!sent.ok) {
    return jsonError(sent.code, sent.message, {
      extra: "retryAfterSeconds" in sent ? { retryAfterSeconds: sent.retryAfterSeconds } : undefined,
    });
  }

  return jsonOk({ codeExpiresAt: sent.codeExpiresAt, resendAt: sent.resendAt });
}
