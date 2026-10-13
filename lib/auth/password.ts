import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing with scrypt from Node's own crypto module.
 *
 * scrypt is memory-hard, which is what makes a stolen hash expensive to
 * attack on GPUs. Parameters and salt are stored inside the hash string
 * so they can be raised later without invalidating existing passwords —
 * `verifyPassword` reads whatever parameters a given hash was made with.
 *
 * Plain text passwords are never written anywhere: not to the database,
 * not to logs.
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const COST = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** 128 * N * r = 33.5 MB for N=32768, above the 32 MB default. */
const MAXMEM = 96 * 1024 * 1024;

/** The stored format: parameters and salt travel with the digest. */
function encode(salt: Buffer, derived: Buffer): string {
  return [
    "scrypt",
    COST.N,
    COST.r,
    COST.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...COST,
    maxmem: MAXMEM,
  });
  return encode(salt, derived);
}

/**
 * The synchronous twin, for the one caller that cannot await: the admin
 * bootstrap, which runs inside the synchronous database open.
 *
 * Identical parameters and identical output format, so `verifyPassword`
 * cannot tell which of the two produced a given hash — the bootstrap
 * admin's password is stored exactly like everybody else's. Nothing on a
 * request path should use this; blocking the event loop for ~100 ms is
 * only acceptable once, at boot.
 */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...COST,
    maxmem: MAXMEM,
  });
  return encode(salt, derived);
}

/**
 * Constant-time comparison. Returns false rather than throwing on a
 * malformed stored value, so a corrupted row cannot become a 500 on the
 * login path.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Burns roughly the same time as a real verification. Called when no
 * account matches the submitted email so that "unknown email" and
 * "wrong password" are indistinguishable from response timing.
 */
export async function fakeVerifyDelay(): Promise<void> {
  try {
    await scryptAsync("timing-equaliser", randomBytes(SALT_BYTES), KEY_LENGTH, {
      ...COST,
      maxmem: MAXMEM,
    });
  } catch {
    /* nothing to do — this call exists only to consume time */
  }
}
