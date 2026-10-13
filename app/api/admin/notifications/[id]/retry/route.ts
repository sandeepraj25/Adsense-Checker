import { deliver, findNotification, requeue } from "@/lib/alerts/notify";
import { requireAdminApi } from "@/lib/auth/guard";
import { jsonError, jsonOk } from "@/lib/http";

export const runtime = "nodejs";

/** Try a failed, retrying or skipped alert again, now. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { id } = await context.params;
  if (!findNotification(id)) return jsonError("NOT_FOUND", "No such alert.");
  if (!requeue(id)) return jsonError("CONFLICT", "That alert was already sent or is being sent right now.");
  const outcome = await deliver(id);
  return jsonOk({ status: outcome, notification: findNotification(id) });
}
