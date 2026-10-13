import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { credentialsSecret } from "@/lib/env";

/**
 * Authenticated encryption for credentials we must store but must never
 * be able to leak in readable form.
 *
 * AES-256-GCM, one random 96-bit IV per record, and the auth tag kept
 * alongside. GCM rather than CBC because a tampered ciphertext must fail
 * loudly rather than decrypt to garbage that some later parser tries to
 * interpret — an admin panel writing an attacker-chosen webhook secret
 * would be worse than an outage.
 *
 * The stored format is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The
 * version prefix exists so a future key rotation or algorithm change can
 * be recognised instead of guessed.
 *
 * The key is derived, not used directly: HKDF-SHA256 over the configured
 * secret with a fixed salt and an `info` label naming this exact use.
 * That means the session-signing path and this path cannot produce the
 * same key even when they are configured from the same variable.
 */

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const HKDF_SALT = "verdict/credentials/v1";
const HKDF_INFO = "payment-gateway-credentials";

let cachedKey: Buffer | null = null;
let cachedFrom: string | null = null;

function key(): Buffer {
  const secret = credentialsSecret();
  if (cachedKey && cachedFrom === secret) return cachedKey;

  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    KEY_BYTES,
  );
  cachedKey = Buffer.from(derived);
  cachedFrom = secret;
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/**
 * Returns null rather than throwing on anything malformed, wrong-keyed or
 * tampered with. A gateway whose credentials cannot be read is treated as
 * unconfigured, which fails closed — checkout refuses instead of dialling
 * a gateway with half a key.
 */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;

  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const body = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;

    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Wrong key, truncated record or a modified ciphertext. All the same
    // answer from here: we do not have usable credentials.
    return null;
  }
}

/**
 * The last four characters of a credential, for the admin panel.
 *
 * Short values are masked entirely rather than partially: revealing three
 * of the four characters of a four-character string is not masking. Long
 * values show a fixed-width run of dots so the display does not leak the
 * real length either.
 */
export function maskTail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return "••••••••••••";
  return `••••••••••••${trimmed.slice(-4)}`;
}

/** Just the four characters, when the caller renders its own dots. */
export function tailOf(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 8 ? "" : trimmed.slice(-4);
}

/** Constant-time string compare, for signatures and shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Comparing lengths first is unavoidable — timingSafeEqual throws on a
  // mismatch — and a length difference is not the secret here.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
