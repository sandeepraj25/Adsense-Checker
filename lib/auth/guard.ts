import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { NextResponse } from "next/server";

import type { User } from "@/lib/db/types";
import { accountBlock } from "@/lib/entitlement";
import { jsonError, type ApiFailure } from "@/lib/http";
import { PATH_HEADER } from "@/lib/request-origin";
import { safeNextPath } from "@/lib/validate";
import { getSessionUser, type ActiveSession } from "./session";

/**
 * Where to send someone back to after they log in again.
 *
 * Layouts cannot see the URL, so `requireUser()` in app/dashboard/layout
 * used to fall back to "/dashboard" — an expired session on
 * /dashboard/billing came back from login on the dashboard home. The
 * path is now forwarded by middleware.ts (which overwrites any copy a
 * client sends) and sanitised again here.
 */
async function returnPath(explicit: string | undefined, fallback: string) {
  if (explicit) return safeNextPath(explicit, fallback);
  const forwarded = (await headers()).get(PATH_HEADER);
  return safeNextPath(forwarded, fallback);
}

async function toLogin(nextPath: string | undefined, fallback: string): Promise<never> {
  const target = await returnPath(nextPath, fallback);
  redirect(`/login?next=${encodeURIComponent(target)}`);
}

/**
 * For server components. Sends anonymous visitors to the login page with
 * a `next` parameter so they land back where they were headed.
 *
 * middleware.ts already turns away requests with no session cookie; this
 * is the authoritative check, because a cookie's presence proves nothing.
 * It only ever reads the session — normal navigation never revokes one.
 */
export async function requireUser(nextPath?: string): Promise<User> {
  const session = await getSessionUser();
  if (!session) return toLogin(nextPath, "/dashboard");
  return session.user;
}

export async function requireSession(nextPath?: string): Promise<ActiveSession> {
  const session = await getSessionUser();
  if (!session) return toLogin(nextPath, "/dashboard");
  return session;
}

/** For route handlers, which answer with JSON rather than a redirect. */
export async function optionalUser(): Promise<User | null> {
  const session = await getSessionUser();
  return session?.user ?? null;
}

/* ── admin ──────────────────────────────────────────────────────── */

/**
 * The gate on every admin page.
 *
 * Blocking a user already deletes their sessions, and the role is read
 * from the row on each request rather than from the cookie, so a
 * demotion or a block takes effect on the admin's very next navigation —
 * there is no signed claim to go stale.
 *
 * A signed-in non-admin gets a 404 rather than a redirect or a "you are
 * not allowed" page: there is no reason to confirm to a customer which
 * internal URLs exist. An admin who lands here after being demoted will
 * see the same 404, which is the price of not leaking the panel.
 */
export async function requireAdmin(nextPath?: string): Promise<User> {
  const session = await getSessionUser();
  if (!session) return toLogin(nextPath, "/admin");
  if (!session.user.isAdmin || session.user.isBlocked) notFound();
  return session.user;
}

/** For rendering the admin link in navigation. Never a control. */
export async function viewerIsAdmin(): Promise<boolean> {
  const session = await getSessionUser();
  return Boolean(session?.user.isAdmin && !session.user.isBlocked);
}

export type AdminGuard =
  | { ok: true; admin: User }
  | { ok: false; response: NextResponse<ApiFailure> };

/**
 * The same gate for route handlers.
 *
 * Every admin API route calls this first. Hiding the links in the UI is
 * not a control — a mutation endpoint that only checked the referring
 * page would be one `curl` away from letting a customer re-price the Pro
 * plan. The status codes differ from the page guard on purpose: an API
 * client benefits from knowing whether to log in again (401) or to stop
 * (403), and neither answer tells an anonymous stranger anything, since
 * you must already hold a valid session to see the 403.
 */
export async function requireAdminApi(): Promise<AdminGuard> {
  const session = await getSessionUser();

  if (!session) {
    return {
      ok: false,
      response: jsonError("UNAUTHENTICATED", "Log in to continue."),
    };
  }

  const blocked = accountBlock(session.user);
  if (blocked) {
    return { ok: false, response: jsonError(blocked.code, blocked.message) };
  }

  if (!session.user.isAdmin) {
    return {
      ok: false,
      response: jsonError(
        "ADMIN_REQUIRED",
        "This action needs an administrator account.",
      ),
    };
  }

  return { ok: true, admin: session.user };
}
