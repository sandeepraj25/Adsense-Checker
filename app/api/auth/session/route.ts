import { getSessionUser } from "@/lib/auth/session";
import { jsonOk } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is signed in, for the navigation on statically rendered pages (the
 * homepage, Team). Read-only: it resolves the same server-side session as
 * every guarded page and never creates, revokes or clears one.
 *
 * This is display information only. Nothing may be authorised from it —
 * every private page and API re-checks the session itself.
 */
export async function GET() {
  const session = await getSessionUser();
  const user = session?.user;

  const response = jsonOk({
    user:
      user && !user.isBlocked
        ? {
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl,
            isAdmin: user.isAdmin,
          }
        : null,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
