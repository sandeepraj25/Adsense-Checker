import type { User } from "@/lib/db/types";
import { safeNextPath } from "@/lib/validate";

/**
 * Where someone goes after logging in (or after verifying a new account).
 *
 * The role comes from the user row the server just loaded — never from
 * the form, the URL or anything in the browser. `requested` is only a
 * hint: it is sanitised, and a customer asking for an admin page is sent
 * to their own dashboard instead (the admin pages would 404 for them
 * anyway; this just avoids landing on that 404).
 */
export function homeFor(user: Pick<User, "isAdmin">): string {
  return user.isAdmin ? "/admin" : "/dashboard";
}

const AUTH_PAGES = ["/login", "/signup", "/verify-email"];

function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`);
}

export function postLoginPath(
  user: Pick<User, "isAdmin">,
  requested: string | null | undefined,
): string {
  const home = homeFor(user);
  const path = safeNextPath(requested, "");
  if (!path) return home;
  if (AUTH_PAGES.some((p) => isUnder(path, p))) return home;
  if (isUnder(path, "/admin") && !user.isAdmin) return "/dashboard";
  return path;
}
