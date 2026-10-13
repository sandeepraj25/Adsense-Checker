import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { authSecret, IS_PROD } from "@/lib/env";
import {
  createSession,
  deleteSession,
  findSessionUser,
  touchSession,
} from "@/lib/db/accounts";
import type { User } from "@/lib/db/types";
import {
  SESSION_COOKIE,
  SESSION_RENEW_THRESHOLD_MS,
  SESSION_TTL_MS,
  SHORT_SESSION_RENEW_THRESHOLD_MS,
  SHORT_SESSION_TTL_MS,
} from "./cookie";

/**
 * Opaque server-side sessions.
 *
 * The cookie holds 32 random bytes and nothing else — no user id, no
 * claims, nothing an attacker could tamper with. The database stores
 * HMAC-SHA256(token, AUTH_SECRET) rather than the token, so a leaked
 * database cannot be replayed as a set of live sessions, and the pepper
 * means the hashes are not precomputable either.
 *
 * Revocation is therefore a DELETE, which a self-contained JWT could
 * not offer.
 */

function sessionIdFor(token: string): string {
  return createHmac("sha256", authSecret()).update(token).digest("hex");
}

/**
 * `expires: null` makes a browser-session cookie (the "remember me"
 * unticked case). Every other attribute is unchanged from before.
 */
function cookieOptions(expires: Date | null) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: IS_PROD,
    path: "/",
    ...(expires ? { expires } : {}),
  };
}

/** Issues a new session and sets the cookie. Route handlers only. */
export async function startSession(
  userId: string,
  meta?: { userAgent?: string | null; ip?: string | null; persistent?: boolean },
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const persistent = meta?.persistent !== false;
  const expiresAt = Date.now() + (persistent ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS);

  createSession({
    id: sessionIdFor(token),
    userId,
    expiresAt,
    userAgent: meta?.userAgent?.slice(0, 300) ?? null,
    ip: meta?.ip?.slice(0, 64) ?? null,
    persistent,
  });

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    token,
    cookieOptions(persistent ? new Date(expiresAt) : null),
  );
}

export type ActiveSession = { user: User; sessionId: string };

/**
 * Resolves the caller. Safe to call from server components, route
 * handlers and server actions.
 *
 * Sliding renewal: once a session is inside its last few days it is
 * extended. Cookies cannot be written during a render, so that write is
 * attempted and allowed to fail quietly — the database row is still
 * extended, and the cookie gets refreshed on the next mutation.
 */
export async function getSessionUser(): Promise<ActiveSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const sessionId = sessionIdFor(token);
  const found = findSessionUser(sessionId);
  if (!found) return null;

  const now = Date.now();
  const { persistent } = found.session;
  const threshold = persistent ? SESSION_RENEW_THRESHOLD_MS : SHORT_SESSION_RENEW_THRESHOLD_MS;
  if (found.session.expiresAt - now < threshold) {
    const expiresAt = now + (persistent ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS);
    touchSession(sessionId, expiresAt, now);
    try {
      store.set(
        SESSION_COOKIE,
        token,
        cookieOptions(persistent ? new Date(expiresAt) : null),
      );
    } catch {
      /* read-only cookie store during render; the row was extended */
    }
  }

  return { user: found.user, sessionId };
}

/** Clears the cookie and removes the row, so the token is dead server-side. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) deleteSession(sessionIdFor(token));
  // Match the original host-only, root-path cookie attributes so browsers
  // reliably replace it. Deleting only client state would leave a usable
  // server session; deleting only the row would leave a confusing stale
  // cookie. Logout deliberately does both.
  store.set(SESSION_COOKIE, "", {
    ...cookieOptions(new Date(0)),
    maxAge: 0,
  });
}

/** After a password change: keep this device, drop every other one. */
export function currentSessionIdFromToken(token: string): string {
  return sessionIdFor(token);
}
