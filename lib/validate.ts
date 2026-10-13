/**
 * Validation shared by the client forms and the API routes, so the
 * rules can never drift apart. Import-safe in the browser: no node
 * builtins in this file.
 *
 * The API always re-validates. Client validation is a convenience,
 * never a control.
 */

export type FieldErrors = Record<string, string>;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Enter your name";
  if (name.length < 2) return "That name looks too short";
  if (name.length > 80) return "Keep your name under 80 characters";
  // Control characters (newlines, NUL, bidi overrides) have no place in a
  // name shown in headers and on invoices.
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)) {
    return "Remove the unusual characters from your name";
  }
  return null;
}

export function validateEmail(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (!email) return "Enter your email";
  if (email.length > 254) return "That email is too long";
  if (!EMAIL_RE.test(email)) return "Enter a valid email address";
  return null;
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Passwords so common that allowing them is negligent. */
const BANNED = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "qwerty123",
  "letmein1",
  "iloveyou",
  "admin123",
  "welcome1",
]);

export function validatePassword(raw: string): string | null {
  if (!raw) return "Choose a password";
  if (raw.length < PASSWORD_MIN)
    return `Use at least ${PASSWORD_MIN} characters`;
  if (raw.length > PASSWORD_MAX) return "That password is too long";
  if (!/[a-z]/.test(raw)) return "Include a lowercase letter";
  if (!/[A-Z]/.test(raw)) return "Include an uppercase letter";
  if (!/[0-9]/.test(raw)) return "Include a number";
  if (BANNED.has(raw.toLowerCase())) return "That password is too common";
  return null;
}

/** 0-4, for the strength meter on the signup form. */
export function passwordStrength(raw: string): {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
} {
  if (!raw) return { score: 0, label: "Empty" };
  let score = 0;
  if (raw.length >= PASSWORD_MIN) score++;
  if (raw.length >= 12) score++;
  if (/[a-z]/.test(raw) && /[A-Z]/.test(raw) && /[0-9]/.test(raw)) score++;
  if (/[^A-Za-z0-9]/.test(raw)) score++;
  if (BANNED.has(raw.toLowerCase())) score = 1;

  const clamped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
  const labels = ["Empty", "Weak", "Fair", "Good", "Strong"] as const;
  return { score: clamped, label: labels[clamped] };
}

export function validateConfirmPassword(
  password: string,
  confirm: string,
): string | null {
  if (!confirm) return "Re-enter your password";
  if (password !== confirm) return "Passwords do not match";
  return null;
}

/**
 * Sanitises a `?next=` redirect target. Anything that is not a plain
 * same-origin path is discarded, which closes the open-redirect hole an
 * attacker would otherwise get by mailing out
 * `/login?next=https://evil.example`.
 *
 * Rejected: absolute URLs, protocol-relative `//host`, and `/\host`
 * (which some browsers normalise to a host).
 */
export function safeNextPath(raw: unknown, fallback = "/dashboard"): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.includes("\n") || value.includes("\r")) return fallback;
  return value;
}
