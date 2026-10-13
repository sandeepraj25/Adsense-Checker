/**
 * Deliberately free of node builtins: `middleware.ts` runs on the edge
 * runtime and must be able to import this, while lib/auth/session.ts
 * (which uses node:crypto) must not be imported there.
 */
export const SESSION_COOKIE = "aec_session";

/** 30 days. Applied to both the cookie and the database row. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Renew once the session is inside its last 5 days. */
export const SESSION_RENEW_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * "Remember me" unticked: the cookie has no expiry, so it ends with the
 * browser session, and the server row lasts a day at most — sliding while
 * the person stays active, so they are not cut off mid-task.
 */
export const SHORT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SHORT_SESSION_RENEW_THRESHOLD_MS = 12 * 60 * 60 * 1000;

/**
 * Holds the random token that ties an email-verification flow to the
 * browser that started it. Not a session: it grants nothing on its own.
 */
export const VERIFY_COOKIE = "aec_verify";
