import { isUniqueViolation, many, one, run, tx } from "./index";
import { toUser, type AccountStatus, type User, type UserRole, type UserRow } from "./types";
import { newId } from "@/lib/ids";
import { normalizeEmail } from "@/lib/validate";

/* ── users ──────────────────────────────────────────────────────── */

export class EmailTakenError extends Error {
  constructor() {
    super("An account with that email already exists");
    this.name = "EmailTakenError";
  }
}

export function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
  /** Set when the address was just confirmed with an emailed code. */
  emailVerifiedAt?: number | null;
}): User {
  const now = Date.now();
  const user: UserRow = {
    id: newId("usr"),
    name: input.name.trim(),
    email: normalizeEmail(input.email),
    password_hash: input.passwordHash,
    created_at: now,
    updated_at: now,
    role: input.role ?? "user",
    status: "active",
    blocked_at: null,
    blocked_reason: null,
    last_active_at: now,
    avatar_key: null,
    email_verified_at: input.emailVerifiedAt ?? null,
  };

  try {
    run(
      `INSERT INTO users
         (id, name, email, password_hash, created_at, updated_at, role, status,
          blocked_at, blocked_reason, last_active_at, email_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.name,
        user.email,
        user.password_hash,
        user.created_at,
        user.updated_at,
        user.role,
        user.status,
        user.blocked_at,
        user.blocked_reason,
        user.last_active_at,
        user.email_verified_at ?? null,
      ],
    );
  } catch (error) {
    // The UNIQUE index is the real defence against duplicate accounts:
    // a pre-check alone would race between two concurrent signups.
    if (isUniqueViolation(error)) throw new EmailTakenError();
    throw error;
  }

  return toUser(user);
}

/** Includes the hash — only for the login path. */
export function findUserRowByEmail(email: string): UserRow | null {
  return one<UserRow>("SELECT * FROM users WHERE email = ?", [
    normalizeEmail(email),
  ]);
}

export function findUserRowById(id: string): UserRow | null {
  return one<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
}

export function findUserById(id: string): User | null {
  const row = findUserRowById(id);
  return row ? toUser(row) : null;
}

export function updateUserName(id: string, name: string): void {
  run("UPDATE users SET name = ?, updated_at = ? WHERE id = ?", [
    name.trim(),
    Date.now(),
    id,
  ]);
}

/**
 * Points the account at a new photo (or none) and returns the key it
 * replaced, so the caller can remove the old file. Scoped by id only:
 * the profile routes pass the caller's own id, never one from the body.
 */
export function setUserAvatarKey(id: string, key: string | null): string | null {
  return tx(() => {
    const previous = one<{ avatar_key: string | null }>(
      "SELECT avatar_key FROM users WHERE id = ?",
      [id],
    );
    if (!previous) return null;
    run("UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ?", [
      key,
      Date.now(),
      id,
    ]);
    return previous.avatar_key ?? null;
  });
}

/** Who owns a stored photo — used to authorise serving it. */
export function findAvatarOwner(key: string): string | null {
  return one<{ id: string }>("SELECT id FROM users WHERE avatar_key = ?", [key])?.id ?? null;
}

export function updateUserPasswordHash(id: string, hash: string): void {
  run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
    hash,
    Date.now(),
    id,
  ]);
}

/* ── sessions ───────────────────────────────────────────────────── */

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: number;
  /** false for a "don't remember me" login: browser-session cookie, short TTL. */
  persistent: boolean;
};

/** `id` must already be the SHA-256 of the cookie token. */
export function createSession(input: {
  id: string;
  userId: string;
  expiresAt: number;
  userAgent?: string | null;
  ip?: string | null;
  persistent?: boolean;
}): void {
  const now = Date.now();
  run(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, persistent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.userId,
      now,
      now,
      input.expiresAt,
      input.userAgent ?? null,
      input.ip ?? null,
      input.persistent === false ? 0 : 1,
    ],
  );
}

/**
 * Resolves a session token hash to its user in one query, rejecting
 * anything already past its expiry.
 *
 * The whole user row is selected rather than a hand-picked few columns,
 * because `role` and `status` are read on every guarded request — an
 * admin check or a blocked-account check that needed a second query would
 * eventually be skipped somewhere it mattered.
 */
export function findSessionUser(
  sessionId: string,
  now = Date.now(),
): { session: SessionRecord; user: User } | null {
  const row = one<
    UserRow & {
      s_id: string;
      s_user_id: string;
      s_expires_at: number;
      s_persistent: number;
    }
  >(
    `SELECT s.id          AS s_id,
            s.user_id     AS s_user_id,
            s.expires_at  AS s_expires_at,
            s.persistent  AS s_persistent,
            u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
    [sessionId, now],
  );

  if (!row) return null;

  return {
    session: {
      id: row.s_id,
      userId: row.s_user_id,
      expiresAt: row.s_expires_at,
      persistent: row.s_persistent !== 0,
    },
    user: toUser(row),
  };
}

/** Rolling expiry, so an active user is not logged out mid-session. */
export function touchSession(
  sessionId: string,
  expiresAt: number,
  now = Date.now(),
): void {
  run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [
    now,
    expiresAt,
    sessionId,
  ]);
}

export function deleteSession(sessionId: string): void {
  run("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

/** Used when the password changes: every other device is signed out. */
export function deleteOtherSessions(userId: string, keepId: string): void {
  run("DELETE FROM sessions WHERE user_id = ? AND id != ?", [userId, keepId]);
}

export function countSessions(userId: string): number {
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?",
    [userId, Date.now()],
  );
  return row?.n ?? 0;
}

export function purgeExpiredSessions(): number {
  return run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]).changes;
}

export function listUserEmails(): string[] {
  return many<{ email: string }>("SELECT email FROM users").map((r) => r.email);
}

/* ── account administration ─────────────────────────────────────── */

export function findUserByEmail(email: string): User | null {
  const row = findUserRowByEmail(email);
  return row ? toUser(row) : null;
}

/**
 * Records that an account did something, for the admin's "last activity"
 * column.
 *
 * Written on session refresh rather than on every request, and never
 * inside a transaction that matters, because a failed activity stamp must
 * not fail the request it was decorating.
 */
export function touchUserActivity(userId: string, now = Date.now()): void {
  run("UPDATE users SET last_active_at = ? WHERE id = ?", [now, userId]);
}

export function setUserRole(userId: string, role: UserRole): void {
  run("UPDATE users SET role = ?, updated_at = ? WHERE id = ?", [
    role,
    Date.now(),
    userId,
  ]);
}

/**
 * Blocks an account and drops every one of its sessions.
 *
 * Clearing the sessions is the part that matters. Flipping a status column
 * alone leaves the person browsing on a cookie that was already accepted,
 * so a block would not take effect until they happened to log out. Both
 * halves go in one transaction so an account is never left blocked-but-
 * signed-in.
 */
export function blockUser(userId: string, reason: string | null): boolean {
  const now = Date.now();
  return tx(() => {
    const changed = run(
      `UPDATE users
          SET status = 'blocked', blocked_at = ?, blocked_reason = ?, updated_at = ?
        WHERE id = ? AND status <> 'blocked'`,
      [now, reason?.slice(0, 300) ?? null, now, userId],
    ).changes;
    if (changed === 1) run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    return changed === 1;
  });
}

export function unblockUser(userId: string): boolean {
  const now = Date.now();
  return (
    run(
      `UPDATE users
          SET status = 'active', blocked_at = NULL, blocked_reason = NULL,
              updated_at = ?
        WHERE id = ? AND status = 'blocked'`,
      [now, userId],
    ).changes === 1
  );
}

export function setUserStatus(
  userId: string,
  status: AccountStatus,
  reason: string | null = null,
): boolean {
  return status === "blocked" ? blockUser(userId, reason) : unblockUser(userId);
}

export function updateUserEmail(userId: string, email: string): boolean {
  try {
    return (
      run("UPDATE users SET email = ?, updated_at = ? WHERE id = ?", [
        normalizeEmail(email),
        Date.now(),
        userId,
      ]).changes === 1
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new EmailTakenError();
    throw error;
  }
}

/**
 * Removes an account and everything hanging off it.
 *
 * Sessions, subscriptions, payments, invoices, websites, reports and
 * findings all carry `ON DELETE CASCADE`, and `PRAGMA foreign_keys = ON`
 * is set when the connection opens, so one DELETE is enough — but the
 * dependents are counted first and returned, because "deleted 1 user"
 * with no mention of the 14 reports that went with it is not informed
 * consent, and the admin UI shows these numbers on the confirm step.
 *
 * Audit log rows are deliberately *not* cascaded away: the record that an
 * admin deleted this account has to outlive the account.
 */
export function summariseUserFootprint(userId: string): {
  websites: number;
  reports: number;
  subscriptions: number;
  payments: number;
  invoices: number;
  sessions: number;
} {
  const count = (table: string) =>
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [
      userId,
    ])?.n ?? 0;
  return {
    websites: count("websites"),
    reports: count("reports"),
    subscriptions: count("subscriptions"),
    payments: count("payments"),
    invoices: count("invoices"),
    sessions: count("sessions"),
  };
}

export function deleteUser(userId: string): boolean {
  return tx(() => {
    // Explicit, in dependency order, rather than trusting that every
    // table's cascade survived a future migration. Cheap insurance
    // against the orphaned rows this would otherwise leave behind.
    run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    run(
      `DELETE FROM report_issues
        WHERE report_id IN (SELECT id FROM reports WHERE user_id = ?)`,
      [userId],
    );
    run("DELETE FROM reports WHERE user_id = ?", [userId]);
    run("DELETE FROM websites WHERE user_id = ?", [userId]);
    run("DELETE FROM invoices WHERE user_id = ?", [userId]);
    run("DELETE FROM payments WHERE user_id = ?", [userId]);
    run("DELETE FROM subscriptions WHERE user_id = ?", [userId]);
    return run("DELETE FROM users WHERE id = ?", [userId]).changes === 1;
  });
}

/** Guard for the last-admin case: never lock everybody out of /admin. */
export function countAdmins(): number {
  return (
    one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      ?.n ?? 0
  );
}
