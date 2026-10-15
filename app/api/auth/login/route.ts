import { requestContext, trackServerEvent } from "@/lib/analytics/store";
import { newUuid } from "@/lib/ids";
import { pendingForLogin, sendFreshCode } from "@/lib/auth/email-verification";
import { fakeVerifyDelay, verifyPassword } from "@/lib/auth/password";
import { postLoginPath } from "@/lib/auth/redirect";
import { startSession } from "@/lib/auth/session";
import { findUserRowByEmail } from "@/lib/db/accounts";
import { expireStaleSubscriptions } from "@/lib/db/billing";
import { jsonError, jsonOk, readJson, str } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { emailLinkOrigin } from "@/lib/env";
import { requestOrigin } from "@/lib/request-origin";
import { normalizeEmail } from "@/lib/validate";

export const runtime = "nodejs";

const GENERIC = "That email and password combination is not right.";

/**
 * The one login for everyone — customers and administrators alike.
 *
 * Nothing in the request says what kind of account this is. The role is
 * read from the user row after the password checks out, and decides only
 * where the browser is sent next (`redirectTo`). Every admin page and API
 * re-checks the role from the database on each request regardless.
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const email = normalizeEmail(str(body.email));
  const password = str(body.password);
  // Absent means "remember", which is how every login behaved before the
  // checkbox existed, so older clients keep their 30-day session.
  const persistent = body.remember !== false;

  if (!email || !password) {
    return jsonError("VALIDATION_ERROR", "Enter your email and password.", {
      fields: {
        ...(email ? {} : { email: "Enter your email" }),
        ...(password ? {} : { password: "Enter your password" }),
      },
    });
  }

  // Two buckets: one per address so a single account cannot be ground
  // down, one per IP so a spray across many addresses is also capped.
  for (const key of [`login:ip:${ip}`, `login:email:${email}`]) {
    const limit = rateLimit(key, 12, 15 * 60 * 1000);
    if (!limit.ok) {
      return jsonError(
        "RATE_LIMITED",
        `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
      );
    }
  }

  const row = findUserRowByEmail(email);

  if (!row) {
    // No account yet — but perhaps a sign-up that was never confirmed.
    // With the right password, the person is sent to finish verifying
    // (with a fresh code) instead of being told the account doesn't exist.
    // Nothing is created and no session is started here.
    const pending = pendingForLogin(email);
    if (pending && (await verifyPassword(password, pending.password_hash))) {
      // Links in the email point at the configured site, not the Host header.
      const origin = emailLinkOrigin(requestOrigin(request.headers, request.url));
      const sent = await sendFreshCode(pending, `${origin}/login`, { rebind: true });
      if (!sent.ok && sent.code !== "RATE_LIMITED") {
        return jsonError(sent.code, sent.message);
      }
      return jsonError(
        "EMAIL_NOT_VERIFIED",
        "Confirm your email address to finish creating your account. We've sent you a code.",
        { extra: { redirectTo: "/verify-email" } },
      );
    }

    // Burn a comparable amount of time so response latency does not
    // reveal which addresses are registered.
    if (!pending) await fakeVerifyDelay();
    return jsonError("INVALID_CREDENTIALS", GENERIC);
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return jsonError("INVALID_CREDENTIALS", GENERIC);

  // Checked after the password, not before: a stranger guessing addresses
  // must not learn which ones are suspended. The owner of the account
  // gets the real reason, because they can act on it.
  if (row.status !== "active") {
    return jsonError(
      "ACCOUNT_BLOCKED",
      row.blocked_reason
        ? `This account has been suspended: ${row.blocked_reason} Contact support if you think this is a mistake.`
        : "This account has been suspended. Contact support if you think this is a mistake.",
    );
  }

  expireStaleSubscriptions();

  await startSession(row.id, {
    userAgent: request.headers.get("user-agent"),
    ip,
    persistent,
  });

  trackServerEvent("login_completed", { key: `login:${newUuid()}`, userId: row.id, context: requestContext(request, ip) });

  const redirectTo = postLoginPath({ isAdmin: row.role === "admin" }, str(body.next));
  return jsonOk({ userId: row.id, redirectTo });
}
