import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { authSecret, IS_PROD } from "@/lib/env";
import { EmailTakenError, createUser, findUserRowByEmail } from "@/lib/db/accounts";
import { opaqueKey, trackServerEvent, type RequestContext } from "@/lib/analytics/store";
import { createSubscription } from "@/lib/db/billing";
import { tx } from "@/lib/db/index";
import {
  consumePending,
  discardCode,
  findPendingByEmail,
  findPendingByFlow,
  purgeExpiredPending,
  recordWrongCode,
  replaceCode,
  setFlow,
  upsertPending,
  type PendingRow,
} from "@/lib/db/pending";
import type { User } from "@/lib/db/types";
import { emailStatus, sendEmail } from "@/lib/email";
import { existingAccountEmail, verificationCodeEmail } from "@/lib/email/templates";
import { requirePlan } from "@/lib/plan-catalogue";
import { DEFAULT_PLAN_ID } from "@/lib/plans";
import { VERIFY_COOKIE } from "./cookie";

/**
 * Email verification for new accounts.
 *
 * Lifecycle
 *   1. sign-up      → a pending row (name, scrypt hash, HMAC of a 6-digit
 *                     code) and an httpOnly cookie tying this browser to it;
 *                     the code is emailed and never stored or returned.
 *   2. verify       → the code is checked against the HMAC in constant
 *                     time, inside one transaction that also deletes the
 *                     pending row and creates the user + free plan. Only
 *                     then is a session started.
 *   3. resend       → a new code replaces the old one (which stops working)
 *                     after a cooldown, within an hourly cap.
 *
 * Limits: a code lives 10 minutes and survives 5 wrong guesses; then it is
 * destroyed and a new one must be requested. A pending sign-up lives 24 h.
 */

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/* ── primitives ─────────────────────────────────────────────────── */

export function generateCode(): string {
  // randomInt draws from the CSPRNG without modulo bias.
  return randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");
}

/** Bound to the address, so a code issued for one email means nothing for another. */
function hashCode(email: string, code: string): string {
  return createHmac("sha256", authSecret())
    .update(`email-otp:v1\0${email}\0${code}`)
    .digest("hex");
}

function hashFlow(token: string): string {
  return createHmac("sha256", authSecret()).update(`verify-flow:v1\0${token}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** "priya@example.com" → "pr•••@example.com". Shown on the verify page. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(3, Math.min(6, local.length - visible.length)))}@${domain}`;
}

/* ── the browser binding ────────────────────────────────────────── */

async function issueFlowCookie(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const store = await cookies();
  store.set(VERIFY_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    path: "/",
    maxAge: PENDING_TTL_MS / 1000,
  });
  return hashFlow(token);
}

async function currentFlowHash(): Promise<string | null> {
  const token = (await cookies()).get(VERIFY_COOKIE)?.value;
  return token ? hashFlow(token) : null;
}

export async function clearFlowCookie(): Promise<void> {
  const store = await cookies();
  store.set(VERIFY_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    path: "/",
    maxAge: 0,
  });
}

/** The pending sign-up this browser is in the middle of, if any. */
export async function currentPending(now = Date.now()): Promise<PendingRow | null> {
  const flow = await currentFlowHash();
  return flow ? findPendingByFlow(flow, now) : null;
}

/* ── sending ────────────────────────────────────────────────────── */

export type SendOutcome =
  | { ok: true; codeExpiresAt: number; resendAt: number }
  | { ok: false; code: "EMAIL_UNCONFIGURED" | "EMAIL_DELIVERY_FAILED"; message: string };

async function deliver(row: { email: string; name: string; decoy: boolean }, code: string, loginUrl: string) {
  const message = row.decoy
    ? existingAccountEmail({ to: row.email, loginUrl })
    : verificationCodeEmail({
        to: row.email,
        name: row.name,
        code,
        minutes: CODE_TTL_MS / 60_000,
      });
  return sendEmail(message);
}

function unconfigured(): SendOutcome | null {
  const status = emailStatus();
  if (status.configured) return null;
  // The reason is for the operator; the person signing up only needs to
  // know it is not them.
  console.error(`[email] Verification email not sent: ${status.problem}`);
  return {
    ok: false,
    code: "EMAIL_UNCONFIGURED",
    message: "We can't send verification emails right now, so new sign-ups are paused. Please try again later.",
  };
}

const DELIVERY_FAILED: SendOutcome = {
  ok: false,
  code: "EMAIL_DELIVERY_FAILED",
  message: "We couldn't send the verification email. Check the address and try again in a moment.",
};

/**
 * Step 1. Starts (or restarts) verification for an address.
 *
 * If the address already has an account, the same steps run with a code
 * nobody is told — the owner gets an "you already have an account" email
 * instead — so the response cannot reveal who is registered.
 */
export async function beginRegistration(input: {
  name: string;
  email: string;
  passwordHash: string;
  nextPath: string | null;
  loginUrl: string;
  /** For analytics only: links the sign-up to the visitor's current visit. */
  analytics?: RequestContext;
}): Promise<SendOutcome> {
  const blocked = unconfigured();
  if (blocked) return blocked;

  const now = Date.now();
  purgeExpiredPending(now);

  const decoy = findUserRowByEmail(input.email) !== null;
  const code = generateCode();
  const codeHash = hashCode(input.email, code);
  const flowHash = await issueFlowCookie();

  upsertPending({
    email: input.email,
    name: input.name,
    passwordHash: decoy ? "" : input.passwordHash,
    decoy,
    flowHash,
    codeHash,
    codeExpiresAt: now + CODE_TTL_MS,
    nextPath: input.nextPath,
    expiresAt: now + PENDING_TTL_MS,
    now,
  });

  const sent = await deliver({ email: input.email, name: input.name, decoy }, code, input.loginUrl);
  if (!sent.ok) {
    // Nothing may be verifiable with a code nobody received.
    discardCode(input.email, codeHash);
    return DELIVERY_FAILED;
  }

  // A real sign-up form (not the look-alike flow for an address that is
  // already registered). One per address per day, without storing it.
  if (!decoy) {
    trackServerEvent("signup_completed", {
      key: `signup:${opaqueKey(input.email)}:${new Date(now).toISOString().slice(0, 10)}`,
      context: input.analytics ?? null,
    });
  }

  return { ok: true, codeExpiresAt: now + CODE_TTL_MS, resendAt: now + RESEND_COOLDOWN_MS };
}

/**
 * Step 3. A new code for the pending sign-up — either the one this
 * browser holds a cookie for, or (after a correct password at login) the
 * one for that address, in which case this browser is bound to it.
 */
export async function sendFreshCode(
  row: PendingRow,
  loginUrl: string,
  options: { rebind?: boolean } = {},
): Promise<SendOutcome | { ok: false; code: "RATE_LIMITED"; message: string; retryAfterSeconds: number }> {
  const blocked = unconfigured();
  if (blocked) return blocked;

  const now = Date.now();
  if (row.last_sent_at && now - row.last_sent_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - row.last_sent_at)) / 1000);
    if (options.rebind) await rebind(row);
    return {
      ok: false,
      code: "RATE_LIMITED",
      message: `A code was sent a moment ago. You can ask for another in ${wait} seconds.`,
      retryAfterSeconds: wait,
    };
  }

  const code = generateCode();
  const codeHash = hashCode(row.email, code);
  const flowHash = options.rebind ? await issueFlowCookie() : row.flow_hash;

  replaceCode({
    email: row.email,
    flowHash,
    codeHash,
    codeExpiresAt: now + CODE_TTL_MS,
    expiresAt: now + PENDING_TTL_MS,
    now,
  });

  const sent = await deliver({ email: row.email, name: row.name, decoy: row.decoy === 1 }, code, loginUrl);
  if (!sent.ok) {
    discardCode(row.email, codeHash);
    return DELIVERY_FAILED;
  }
  return { ok: true, codeExpiresAt: now + CODE_TTL_MS, resendAt: now + RESEND_COOLDOWN_MS };
}

/** Points this browser at an existing pending row without changing its code. */
async function rebind(row: PendingRow): Promise<void> {
  setFlow(row.email, await issueFlowCookie());
}

/** Login found no account but a pending sign-up whose password matched. */
export function pendingForLogin(email: string): PendingRow | null {
  const row = findPendingByEmail(email);
  return row && row.decoy === 0 ? row : null;
}

/* ── verifying ──────────────────────────────────────────────────── */

export type VerifyOutcome =
  | { ok: true; user: User; nextPath: string | null }
  | {
      ok: false;
      code: "VERIFICATION_NOT_FOUND" | "CODE_INVALID" | "CODE_EXPIRED" | "CODE_LOCKED";
      message: string;
      attemptsLeft?: number;
    };

/**
 * Step 2. Everything that decides the outcome happens inside one
 * synchronous transaction, so two requests racing with the same code
 * cannot both succeed: the second finds the pending row already gone.
 */
export async function verifyCode(rawCode: unknown): Promise<VerifyOutcome> {
  const flow = await currentFlowHash();
  const code = normalizeCode(rawCode);

  const notFound: VerifyOutcome = {
    ok: false,
    code: "VERIFICATION_NOT_FOUND",
    message: "This verification has ended. Sign up again or log in to get a new code.",
  };
  if (!flow) return notFound;
  // A malformed entry is a typo, not a guess: it does not use up a try.
  if (code === null) {
    return { ok: false, code: "CODE_INVALID", message: "Enter the 6-digit code from the email." };
  }

  const result = tx((): VerifyOutcome => {
    const now = Date.now();
    const row = findPendingByFlow(flow, now);
    if (!row) return notFound;

    if (!row.code_hash) {
      return {
        ok: false,
        code: "CODE_LOCKED",
        message: "This code can't be used any more. Send a new code and try again.",
      };
    }
    if (!row.code_expires_at || row.code_expires_at <= now) {
      return { ok: false, code: "CODE_EXPIRED", message: "This code has expired. Send a new code." };
    }

    const matches = !row.decoy && sameHash(hashCode(row.email, code), row.code_hash);

    if (!matches) {
      const attempts = recordWrongCode(row.email, row.code_hash, MAX_ATTEMPTS);
      const left = Math.max(0, MAX_ATTEMPTS - attempts);
      if (left === 0) {
        return {
          ok: false,
          code: "CODE_LOCKED",
          message: "Too many incorrect codes. Send a new code and try again.",
        };
      }
      return {
        ok: false,
        code: "CODE_INVALID",
        message: `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`,
        attemptsLeft: left,
      };
    }

    // Single use: only the request that deletes the row may create the user.
    if (!consumePending(row.email, row.code_hash)) return notFound;

    let user: User;
    try {
      user = createUser({
        name: row.name,
        email: row.email,
        passwordHash: row.password_hash,
        emailVerifiedAt: now,
      });
    } catch (error) {
      if (error instanceof EmailTakenError) {
        // Someone else got the address first (e.g. an admin moved an
        // account onto it). The pending row is already gone.
        return {
          ok: false,
          code: "VERIFICATION_NOT_FOUND",
          message: "An account with this email already exists. Log in instead.",
        };
      }
      throw error;
    }

    // Same free plan sign-up always granted, now granted on verification.
    createSubscription({
      userId: user.id,
      plan: requirePlan(DEFAULT_PLAN_ID),
      paymentStatus: "free",
      amountPaise: 0,
    });

    return { ok: true, user, nextPath: row.next_path };
  });

  if (result.ok || result.code === "VERIFICATION_NOT_FOUND") await clearFlowCookie();
  return result;
}
