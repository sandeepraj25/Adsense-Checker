import { getSessionUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/http";
import { updateOwnName } from "@/lib/profile";

export const runtime = "nodejs";

/**
 * Renames the signed-in account. Email is deliberately not editable here.
 * Only `name` is read from the body — see lib/profile.ts.
 */
export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!session) return jsonError("UNAUTHENTICATED", "Log in to change this.");
  return updateOwnName(session.user, request);
}

export const PATCH = POST;
