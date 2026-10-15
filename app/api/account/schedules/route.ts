import { getSessionUser } from "@/lib/auth/session";
import { websiteExists } from "@/lib/db/audits";
import { accountBlock } from "@/lib/entitlement";
import { jsonError, jsonOk, jsonServerError, readJson, str } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { canSchedule, setSchedule } from "@/lib/schedules/store";

export const runtime = "nodejs";

/**
 * Turns weekly rescans of one site on or off for the signed-in account.
 * Turning on needs a plan that includes weekly rescans and a site this
 * account has scanned; turning off is always allowed.
 */
export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!session) return jsonError("UNAUTHENTICATED", "Log in to change weekly rescans.");
  const blocked = accountBlock(session.user);
  if (blocked) return jsonError(blocked.code, blocked.message);
  if (!rateLimit(`schedules:${session.user.id}`, 20, 60 * 60 * 1000).ok) {
    return jsonError("RATE_LIMITED", "Too many changes. Try again later.");
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  const domain = str(body.domain).trim().toLowerCase();
  if (!domain || typeof body.enabled !== "boolean") return jsonError("VALIDATION_ERROR", "Send a domain and enabled: true or false.");
  if (!websiteExists(session.user.id, domain)) return jsonError("NOT_FOUND", "Scan this site first, then turn on weekly rescans.");

  try {
    if (body.enabled) {
      const allowed = canSchedule(session.user.id);
      if (!allowed.ok) return jsonError("FEATURE_LOCKED", allowed.reason);
    }
    const schedule = setSchedule({ userId: session.user.id, domain, enabled: body.enabled });
    return jsonOk({ enabled: schedule.enabled, state: schedule.state, nextRunAt: schedule.enabled ? schedule.nextRunAt : null });
  } catch (error) {
    return jsonServerError("account/schedules", error);
  }
}
