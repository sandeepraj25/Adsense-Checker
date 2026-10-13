import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getSessionUser } from "@/lib/auth/session";
import {
  deleteOtherSessions,
  findUserRowById,
  updateUserPasswordHash,
} from "@/lib/db/accounts";
import { jsonError, jsonOk, readJson, str } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { validateConfirmPassword, validatePassword } from "@/lib/validate";

export const runtime = "nodejs";

/**
 * Changes the password of the signed-in account.
 *
 * The current password is required — a stolen session should not be
 * enough to lock the owner out. On success every *other* session is
 * revoked, which is the whole point of changing a password: whoever
 * else was signed in is now signed out.
 */
export async function POST(request: Request) {
  const session = await getSessionUser();
  if (!session) {
    return jsonError("UNAUTHENTICATED", "Log in to change your password.");
  }

  const limit = rateLimit(`password:${session.user.id}`, 10, 15 * 60 * 1000);
  if (!limit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const currentPassword = str(body.currentPassword);
  const newPassword = str(body.newPassword);
  const confirmPassword = str(body.confirmPassword);

  if (!currentPassword) {
    return jsonError("VALIDATION_ERROR", "Enter your current password.", {
      fields: { currentPassword: "Enter your current password" },
    });
  }

  const strength = validatePassword(newPassword);
  if (strength) {
    return jsonError("VALIDATION_ERROR", strength, {
      fields: { newPassword: strength },
    });
  }

  const mismatch = validateConfirmPassword(newPassword, confirmPassword);
  if (mismatch) {
    return jsonError("VALIDATION_ERROR", mismatch, {
      fields: { confirmPassword: mismatch },
    });
  }

  const row = findUserRowById(session.user.id);
  if (!row) return jsonError("UNAUTHENTICATED", "Log in again.");

  const valid = await verifyPassword(currentPassword, row.password_hash);
  if (!valid) {
    return jsonError(
      "INVALID_CREDENTIALS",
      "That is not your current password.",
      { fields: { currentPassword: "This does not match your password" } },
    );
  }

  if (currentPassword === newPassword) {
    return jsonError(
      "VALIDATION_ERROR",
      "Choose a password you have not used here before.",
      { fields: { newPassword: "This is your current password" } },
    );
  }

  updateUserPasswordHash(session.user.id, await hashPassword(newPassword));
  deleteOtherSessions(session.user.id, session.sessionId);

  return jsonOk({ changed: true });
}
