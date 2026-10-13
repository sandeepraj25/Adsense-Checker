import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { hashPasswordSync } from "@/lib/auth/password";
import {
  ADMIN_EMAIL,
  ADMIN_NAME,
  ADMIN_PASSWORD,
  DATA_DIR,
  ensureDataDir,
} from "@/lib/env";
import { PLAN_LIST } from "@/lib/plans";
import { validatePassword } from "@/lib/validate";
import { MIGRATIONS } from "./schema";

/**
 * Persistence is Node's built-in SQLite (`node:sqlite`) — a real
 * transactional SQL database in a single file, with no dependency to
 * install and nothing to provision before `npm run dev` works.
 *
 * Everything above this module talks in plain SQL through `one`,
 * `many`, `run` and `tx`. The driver is referenced only here, so
 * moving to Postgres later means reimplementing this one file plus the
 * placeholder style, not touching the repositories' call sites.
 *
 * Requires Node >= 22.5 (see `engines` in package.json).
 */

export type SqlValue = string | number | null | Uint8Array | bigint;

const DB_FILE = path.join(DATA_DIR, "app.db");

type GlobalWithDb = typeof globalThis & { __appDb?: DatabaseSync };
const globalRef = globalThis as GlobalWithDb;

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return Number(row?.user_version ?? 0);
}

function migrate(db: DatabaseSync): void {
  const from = currentVersion(db);
  for (let i = from; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      // Safe interpolation: the value is a loop index, not user input.
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${i + 1} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Seeds the plans table from lib/plans.ts — and only seeds it.
 *
 * `DO NOTHING` rather than `DO UPDATE` is the whole point. The table is
 * authoritative at runtime because an admin can re-price plans and toggle
 * features from the panel; if boot overwrote those rows from the source
 * defaults, every restart would silently revert the operator's pricing.
 * A missing row is filled in, an existing one is left alone.
 *
 * The reverse hazard is worth naming: changing a default in lib/plans.ts
 * will not move an install that already has the row. Change it in the
 * admin panel, or delete the row to re-seed.
 */
function seedPlans(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO plans (id, name, tagline, amount_paise, currency,
                        billing_interval, site_limit, scan_limit, purchasable,
                        featured, active, features_json, showcase_json,
                        excluded_json, highlights_json, sort_order, updated_at,
                        updated_by, usd_amount_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const now = Date.now();
  PLAN_LIST.forEach((plan, index) => {
    stmt.run(
      plan.id,
      plan.name,
      plan.tagline,
      plan.amountPaise,
      plan.currency,
      plan.interval,
      plan.siteLimit,
      plan.scanLimit,
      plan.purchasable ? 1 : 0,
      plan.featured ? 1 : 0,
      plan.active ? 1 : 0,
      JSON.stringify(plan.features),
      JSON.stringify(plan.showcase),
      JSON.stringify(plan.excluded),
      JSON.stringify(plan.highlights),
      index,
      now,
      plan.usdAmountCents,
    );
  });
}

/**
 * Creates a disabled row for each gateway we can talk to.
 *
 * Disabled and credential-less is the only safe default: an enabled
 * gateway with no keys would offer a checkout button that cannot take
 * money. An operator turns one on from /admin/payment-gateways after
 * pasting its keys.
 */
function seedGateways(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO payment_gateways
       (id, enabled, environment, credentials_cipher, credential_tails_json,
        updated_at, updated_by)
     VALUES (?, 0, 'sandbox', NULL, '{}', ?, NULL)
     ON CONFLICT(id) DO NOTHING`,
  );
  const now = Date.now();
  for (const id of ["razorpay", "cashfree", "paypal"]) stmt.run(id, now);
}

/**
 * Applies ADMIN_EMAIL / ADMIN_PASSWORD, so a fresh deployment has a way
 * into /admin without a signup form for administrators.
 *
 * Three deliberate properties:
 *
 * - The password is hashed with the same scrypt parameters as any other
 *   account. Plain text is never written to the database.
 * - If the address already has an account, only its role is raised. A
 *   password the admin later changed is never reset by a redeploy, and a
 *   stale ADMIN_PASSWORD left in the environment cannot be used to take
 *   an account over.
 * - Nothing happens at all unless both variables are set, so the default
 *   install has no admin credentials to guess.
 *
 * Raising an existing account also clears a block: locking yourself out
 * and then being unable to unblock yourself would be unrecoverable.
 */
function seedAdmin(db: DatabaseSync): void {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;

  const now = Date.now();
  const existing = db
    .prepare("SELECT id, role FROM users WHERE email = ?")
    .get(ADMIN_EMAIL) as { id?: string; role?: string } | undefined;

  if (existing?.id) {
    if (existing.role !== "admin") {
      db.prepare(
        `UPDATE users
            SET role = 'admin', status = 'active', blocked_at = NULL,
                blocked_reason = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(now, existing.id);
      console.warn(`[admin] Raised ${ADMIN_EMAIL} to administrator.`);
    }
    return;
  }

  const weak = validatePassword(ADMIN_PASSWORD);
  if (weak) {
    console.error(
      `[admin] ADMIN_PASSWORD was rejected (${weak.toLowerCase()}). ` +
        "No administrator account was created. Set a stronger " +
        "ADMIN_PASSWORD and restart.",
    );
    return;
  }

  db.prepare(
    `INSERT INTO users
       (id, name, email, password_hash, created_at, updated_at, role, status,
        blocked_at, blocked_reason, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', 'active', NULL, NULL, NULL)`,
  ).run(
    `usr_${randomBytes(12).toString("base64url")}`,
    ADMIN_NAME,
    ADMIN_EMAIL,
    hashPasswordSync(ADMIN_PASSWORD),
    now,
    now,
  );
  console.warn(
    `[admin] Created the administrator account ${ADMIN_EMAIL}. ` +
      "Log in and change the password, then remove ADMIN_PASSWORD from the " +
      "environment.",
  );
}

function open(): DatabaseSync {
  ensureDataDir();

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(DB_FILE);
  } catch (error) {
    throw new Error(
      `Could not open the database at ${DB_FILE}. ` +
        `node:sqlite requires Node 22.5 or newer (running ${process.version}). ` +
        `Original error: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }

  // WAL keeps reads from blocking the write that a running audit does.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db);
  seedPlans(db);
  seedGateways(db);
  seedAdmin(db);
  return db;
}

/** Cached across hot reloads so dev does not leak file handles. */
export function getDb(): DatabaseSync {
  if (!globalRef.__appDb) globalRef.__appDb = open();
  return globalRef.__appDb;
}

/**
 * node:sqlite returns rows with a null prototype. Those cannot be
 * handed to a client component — Next cannot serialise them — so every
 * row is copied into a plain object on the way out.
 */
function plain<T>(row: unknown): T {
  return Object.assign({}, row) as T;
}

export function one<T>(sql: string, params: SqlValue[] = []): T | null {
  const row = getDb()
    .prepare(sql)
    .get(...params);
  return row === undefined ? null : plain<T>(row);
}

export function many<T>(sql: string, params: SqlValue[] = []): T[] {
  return getDb()
    .prepare(sql)
    .all(...params)
    .map((row) => plain<T>(row));
}

export function run(
  sql: string,
  params: SqlValue[] = [],
): { changes: number; lastInsertRowid: number | bigint } {
  const result = getDb()
    .prepare(sql)
    .run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: result.lastInsertRowid,
  };
}

/** Synchronous transaction. Rolls back if `fn` throws. */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction was already resolved */
    }
    throw error;
  }
}

/** SQLite cannot bind booleans. */
export function bit(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}
