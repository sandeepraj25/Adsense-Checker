import { getSessionUser } from "@/lib/auth/session";
import { readAvatar } from "@/lib/avatars";
import { findAvatarOwner } from "@/lib/db/accounts";
import { AVATAR_KEY_PATTERN } from "@/lib/db/types";

export const runtime = "nodejs";

/**
 * Serves a stored profile photo.
 *
 * Photos are personal data, so this is not a public file server: the
 * caller must be signed in and be either the photo's owner or an admin.
 * Anything else — a malformed key, someone else's photo, a key that is
 * no longer in use — gets the same 404, so the endpoint cannot be used
 * to discover which keys exist.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const notFound = () => new Response("Not found", { status: 404 });

  if (!AVATAR_KEY_PATTERN.test(key)) return notFound();

  const session = await getSessionUser();
  if (!session) return notFound();

  const owner = findAvatarOwner(key);
  if (!owner) return notFound();
  if (owner !== session.user.id && !(session.user.isAdmin && !session.user.isBlocked)) {
    return notFound();
  }

  const image = await readAvatar(key);
  if (!image) return notFound();

  return new Response(new Uint8Array(image), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(image.byteLength),
      // A new upload gets a new key, so a given URL never changes content.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
