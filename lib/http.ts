import { NextResponse } from "next/server";

/**
 * One vocabulary of failures for the whole API. The client switches on
 * `code`; `message` is already written for a human to read, so the UI
 * can surface it directly without inventing its own copy.
 */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "ADMIN_REQUIRED"
  | "ACCOUNT_BLOCKED"
  | "EMAIL_TAKEN"
  | "INVALID_CREDENTIALS"
  | "NO_ACTIVE_PLAN"
  | "PLAN_EXPIRED"
  | "LIMIT_REACHED"
  | "SITE_LIMIT_REACHED"
  | "FEATURE_LOCKED"
  | "INVALID_URL"
  | "URL_NOT_ALLOWED"
  | "SITE_UNREACHABLE"
  | "DNS_FAILURE"
  | "PAYMENTS_UNCONFIGURED"
  | "GATEWAY_DISABLED"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELLED"
  | "PAYMENT_VERIFICATION_FAILED"
  | "WEBHOOK_INVALID"
  | "ORDER_NOT_FOUND"
  | "CHECKOUT_ATTEMPT_USED"
  | "ANALYSIS_FAILED"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "PRICE_NOT_CONFIGURED"
  | "CURRENCY_UNSUPPORTED"
  | "PRICE_CHANGED"
  | "CONFIRMATION_REQUIRED"
  | "EMAIL_NOT_VERIFIED"
  | "CODE_INVALID"
  | "CODE_EXPIRED"
  | "CODE_LOCKED"
  | "VERIFICATION_NOT_FOUND"
  | "EMAIL_UNCONFIGURED"
  | "EMAIL_DELIVERY_FAILED"
  | "NOT_FOUND"
  | "SCAN_IN_PROGRESS"
  | "SERVER_ERROR";

export type ApiFailure = {
  ok: false;
  code: ApiErrorCode;
  message: string;
  /** Field-level messages keyed by input name, for forms. */
  fields?: Record<string, string>;
  /** Safe, non-secret hints for the client, e.g. where to go next. */
  [extra: string]: unknown;
};

export type ApiSuccess<T> = { ok: true } & T;

export function jsonOk<T extends object>(
  data: T,
  status = 200,
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ ok: true, ...data } as ApiSuccess<T>, { status });
}

const DEFAULT_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ADMIN_REQUIRED: 403,
  ACCOUNT_BLOCKED: 403,
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  NO_ACTIVE_PLAN: 402,
  PLAN_EXPIRED: 402,
  LIMIT_REACHED: 402,
  SITE_LIMIT_REACHED: 402,
  FEATURE_LOCKED: 402,
  INVALID_URL: 400,
  // A refusal, not a malformed input: the address parsed fine, we simply
  // will not dial it.
  URL_NOT_ALLOWED: 400,
  SITE_UNREACHABLE: 422,
  DNS_FAILURE: 422,
  PAYMENTS_UNCONFIGURED: 503,
  GATEWAY_DISABLED: 503,
  PAYMENT_FAILED: 402,
  PAYMENT_CANCELLED: 409,
  PAYMENT_VERIFICATION_FAILED: 400,
  WEBHOOK_INVALID: 400,
  ORDER_NOT_FOUND: 404,
  CHECKOUT_ATTEMPT_USED: 409,
  ANALYSIS_FAILED: 502,
  RATE_LIMITED: 429,
  // The plan has no price in the chosen currency / the gateway can't take it.
  // The change would break something that depends on the record.
  CONFLICT: 409,
  PRICE_NOT_CONFIGURED: 422,
  CURRENCY_UNSUPPORTED: 422,
  // The checkout page is stale: the site currency or price changed.
  PRICE_CHANGED: 409,
  // A disruptive admin change must be resent with `confirmed: true`.
  CONFIRMATION_REQUIRED: 409,
  // Right password, but the address was never confirmed: the client is
  // sent to /verify-email with a fresh code rather than into the app.
  EMAIL_NOT_VERIFIED: 403,
  CODE_INVALID: 400,
  CODE_EXPIRED: 410,
  CODE_LOCKED: 429,
  VERIFICATION_NOT_FOUND: 404,
  EMAIL_UNCONFIGURED: 503,
  EMAIL_DELIVERY_FAILED: 502,
  NOT_FOUND: 404,
  SCAN_IN_PROGRESS: 409,
  SERVER_ERROR: 500,
};

/**
 * Turns an unexpected exception into a response.
 *
 * The message the caller sees is fixed copy; the real error goes to the
 * server log. A stack trace or a SQL fragment in a JSON body tells an
 * attacker about the inside of the system and tells the user nothing they
 * can act on.
 */
export function jsonServerError(
  context: string,
  error: unknown,
): NextResponse<ApiFailure> {
  console.error(`[${context}]`, error);
  return jsonError(
    "SERVER_ERROR",
    "Something went wrong on our side. Try again in a moment.",
  );
}

export function jsonError(
  code: ApiErrorCode,
  message: string,
  options?: {
    status?: number;
    fields?: Record<string, string>;
    extra?: Record<string, string | number | boolean | null>;
  },
): NextResponse<ApiFailure> {
  const body: ApiFailure = { ...(options?.extra ?? {}), ok: false, code, message };
  if (options?.fields) body.fields = options.fields;
  return NextResponse.json(body, {
    status: options?.status ?? DEFAULT_STATUS[code],
  });
}

/** Parses a JSON body without letting a malformed payload throw a 500. */
export async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A whole number from a JSON body, or null when the value is not one.
 *
 * Strings are accepted because a number typed into a form arrives as one,
 * but "12abc" and "" are refused rather than coerced — `parseInt` alone
 * would turn the first into 12 and `Number("")` would turn the second
 * into 0, and an admin form is the wrong place to guess.
 */
export function int(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** JSON booleans, plus the "true"/"false" strings a form field sends. */
export function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

/** A JSON array of strings, or null for anything else. */
export function strList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}
