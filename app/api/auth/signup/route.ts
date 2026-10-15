import { requestContext } from "@/lib/analytics/store";
import { beginRegistration } from "@/lib/auth/email-verification";
import { hashPassword } from "@/lib/auth/password";
import { jsonError, jsonOk, readJson, str } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { emailLinkOrigin } from "@/lib/env";
import { requestOrigin } from "@/lib/request-origin";
import {
  normalizeEmail,
  safeNextPath,
  validateConfirmPassword,
  validateEmail,
  validateName,
  validatePassword,
  type FieldErrors,
} from "@/lib/validate";

export const runtime = "nodejs";

/**
 * Step 1 of sign-up: validate, then start email verification.
 *
 * No user row and no session are created here — that happens only in
 * /api/auth/verify-email once the emailed code is confirmed. The role is
 * never read from the body: every account made this way is a customer.
 *
 * The response is the same whether or not the address already has an
 * account (see beginRegistration's "decoy" path), so this endpoint cannot
 * be used to find out who is registered.
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  const ipLimit = rateLimit(`signup:ip:${ip}`, 10, 60 * 60 * 1000);
  if (!ipLimit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many sign-up attempts. Try again in ${ipLimit.retryAfterSeconds} seconds.`,
    );
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const name = str(body.name).trim();
  const email = normalizeEmail(str(body.email));
  const password = str(body.password);
  const confirmPassword = str(body.confirmPassword);
  const nextPath = safeNextPath(str(body.next), "") || null;

  const fields: FieldErrors = {};
  const nameError = validateName(name);
  if (nameError) fields.name = nameError;
  const emailError = validateEmail(email);
  if (emailError) fields.email = emailError;
  const passwordError = validatePassword(password);
  if (passwordError) fields.password = passwordError;
  const confirmError = validateConfirmPassword(password, confirmPassword);
  if (confirmError) fields.confirmPassword = confirmError;

  if (Object.keys(fields).length > 0) {
    return jsonError("VALIDATION_ERROR", "Check the highlighted fields.", {
      fields,
    });
  }

  // Each sign-up sends an email, so an address gets its own cap — someone
  // cannot flood a stranger's inbox by signing up as them over and over.
  const emailLimit = rateLimit(`signup:email:${email}`, 5, 60 * 60 * 1000);
  if (!emailLimit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many codes were requested for this address. Try again in ${Math.ceil(emailLimit.retryAfterSeconds / 60)} minutes.`,
    );
  }

  const passwordHash = await hashPassword(password);
  // Links in the email point at the configured site, not the Host header.
  const origin = emailLinkOrigin(requestOrigin(request.headers, request.url));

  const outcome = await beginRegistration({
    name,
    email,
    passwordHash,
    nextPath,
    loginUrl: `${origin}/login`,
    analytics: requestContext(request, clientIp(request)),
  });

  if (!outcome.ok) return jsonError(outcome.code, outcome.message);

  return jsonOk(
    {
      verification: {
        redirectTo: "/verify-email",
        codeExpiresAt: outcome.codeExpiresAt,
        resendAt: outcome.resendAt,
      },
    },
    202,
  );
}
