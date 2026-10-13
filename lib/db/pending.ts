import { one, run } from "./index";

/**
 * Sign-ups waiting for their email code. See the V5 migration for why
 * these live outside `users`. Every function is synchronous so callers can
 * compose them inside one `tx()`.
 */

export type PendingRow = {
  email: string;
  name: string;
  password_hash: string;
  decoy: number;
  flow_hash: string;
  code_hash: string | null;
  code_expires_at: number | null;
  attempts: number;
  last_sent_at: number | null;
  next_path: string | null;
  created_at: number;
  expires_at: number;
};

/** One row per address: a new sign-up for the same email replaces the old one. */
export function upsertPending(input: {
  email: string;
  name: string;
  passwordHash: string;
  decoy: boolean;
  flowHash: string;
  codeHash: string;
  codeExpiresAt: number;
  nextPath: string | null;
  expiresAt: number;
  now: number;
}): void {
  run(
    `INSERT INTO pending_registrations
       (email, name, password_hash, decoy, flow_hash, code_hash, code_expires_at,
        attempts, last_sent_at, next_path, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name,
       password_hash = excluded.password_hash,
       decoy = excluded.decoy,
       flow_hash = excluded.flow_hash,
       code_hash = excluded.code_hash,
       code_expires_at = excluded.code_expires_at,
       attempts = 0,
       last_sent_at = excluded.last_sent_at,
       next_path = excluded.next_path,
       expires_at = excluded.expires_at`,
    [
      input.email,
      input.name,
      input.passwordHash,
      input.decoy ? 1 : 0,
      input.flowHash,
      input.codeHash,
      input.codeExpiresAt,
      input.now,
      input.nextPath,
      input.now,
      input.expiresAt,
    ],
  );
}

export function findPendingByFlow(flowHash: string, now = Date.now()): PendingRow | null {
  return one<PendingRow>(
    "SELECT * FROM pending_registrations WHERE flow_hash = ? AND expires_at > ?",
    [flowHash, now],
  );
}

export function findPendingByEmail(email: string, now = Date.now()): PendingRow | null {
  return one<PendingRow>(
    "SELECT * FROM pending_registrations WHERE email = ? AND expires_at > ?",
    [email, now],
  );
}

/** A fresh code replaces the previous one outright — the old code stops working. */
export function replaceCode(input: {
  email: string;
  flowHash: string;
  codeHash: string;
  codeExpiresAt: number;
  expiresAt: number;
  now: number;
}): boolean {
  return (
    run(
      `UPDATE pending_registrations
          SET flow_hash = ?, code_hash = ?, code_expires_at = ?, attempts = 0,
              last_sent_at = ?, expires_at = MAX(expires_at, ?)
        WHERE email = ?`,
      [
        input.flowHash,
        input.codeHash,
        input.codeExpiresAt,
        input.now,
        input.expiresAt,
        input.email,
      ],
    ).changes === 1
  );
}

/** Counts a wrong guess. At `max`, the code is destroyed and a new one is needed. */
export function recordWrongCode(email: string, codeHash: string, max: number): number {
  run(
    `UPDATE pending_registrations
        SET attempts = attempts + 1,
            code_hash = CASE WHEN attempts + 1 >= ? THEN NULL ELSE code_hash END
      WHERE email = ? AND code_hash = ?`,
    [max, email, codeHash],
  );
  return (
    one<{ attempts: number }>(
      "SELECT attempts FROM pending_registrations WHERE email = ?",
      [email],
    )?.attempts ?? max
  );
}

/** Used when the email carrying a code could not be sent: nothing to verify against. */
export function discardCode(email: string, codeHash: string): void {
  run(
    "UPDATE pending_registrations SET code_hash = NULL WHERE email = ? AND code_hash = ?",
    [email, codeHash],
  );
}

/**
 * Deletes the row only if it still carries this exact code. Inside the
 * verification transaction this is the single-use guard: a second request
 * with the same code finds zero rows to delete and is refused.
 */
export function consumePending(email: string, codeHash: string): boolean {
  return (
    run("DELETE FROM pending_registrations WHERE email = ? AND code_hash = ?", [
      email,
      codeHash,
    ]).changes === 1
  );
}

export function deletePending(email: string): void {
  run("DELETE FROM pending_registrations WHERE email = ?", [email]);
}

export function purgeExpiredPending(now = Date.now()): number {
  return run("DELETE FROM pending_registrations WHERE expires_at <= ?", [now]).changes;
}

/** Moves the browser binding only; the code, its expiry and the attempt count stay. */
export function setFlow(email: string, flowHash: string): void {
  run("UPDATE pending_registrations SET flow_hash = ? WHERE email = ?", [flowHash, email]);
}
