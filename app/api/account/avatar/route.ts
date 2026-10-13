import { getSessionUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/http";
import { removeOwnAvatar, uploadOwnAvatar } from "@/lib/profile";

export const runtime = "nodejs";

/** Uploads or replaces the signed-in account's own profile photo. */
export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!session) return jsonError("UNAUTHENTICATED", "Log in to change your photo.");
  return uploadOwnAvatar(session.user, request);
}

/** Removes the photo; the initials avatar is shown again. */
export async function DELETE() {
  const session = await getSessionUser();
  if (!session) return jsonError("UNAUTHENTICATED", "Log in to change your photo.");
  return removeOwnAvatar(session.user);
}
