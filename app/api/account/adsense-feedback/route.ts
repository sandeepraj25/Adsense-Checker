import { getSessionUser } from "@/lib/auth/session";
import { accountBlock } from "@/lib/entitlement";
import { jsonError, jsonOk, jsonServerError, readJson, str } from "@/lib/http";
import { submitFeedback } from "@/lib/ml/feedback";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * "Did AdSense approve your site?" — the answer from the dashboard card.
 * The account must be signed in and not blocked, and may only answer its
 * own prompts (ownership is checked in the query). Every submission,
 * including refused ones, is recorded with the reason.
 */
export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!session) return jsonError("UNAUTHENTICATED", "Log in to answer.");
  const blocked = accountBlock(session.user);
  if (blocked) return jsonError(blocked.code, blocked.message);

  const limit = rateLimit(`adsense-feedback:${session.user.id}`, 10, 60 * 60 * 1000);
  if (!limit.ok) {
    return jsonError("RATE_LIMITED", `Too many answers at once. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`);
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  const requestId = str(body.requestId).trim();
  if (!requestId) return jsonError("VALIDATION_ERROR", "Missing question id.");

  try {
    const result = submitFeedback({
      userId: session.user.id,
      accountCreatedAt: session.user.createdAt,
      requestId,
      outcome: body.outcome,
      reason: body.reason,
    });
    if (!result.ok) return jsonError(result.code, result.message);
    return jsonOk({ status: result.status, message: result.message });
  } catch (error) {
    return jsonServerError("account/adsense-feedback", error);
  }
}
