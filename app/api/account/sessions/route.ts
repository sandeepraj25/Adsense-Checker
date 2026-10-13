import { getSessionUser } from "@/lib/auth/session";
import { countSessions, deleteOtherSessions } from "@/lib/db/accounts";
import { jsonError, jsonOk } from "@/lib/http";

export const runtime = "nodejs";

/** Signs out every device except this one. */
export async function POST() {
  const session = await getSessionUser();
  if (!session) return jsonError("UNAUTHENTICATED", "Log in first.");

  const before = countSessions(session.user.id);
  deleteOtherSessions(session.user.id, session.sessionId);

  return jsonOk({ revoked: Math.max(0, before - 1) });
}
