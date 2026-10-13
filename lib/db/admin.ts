import { many, one, run } from "./index";
import {
  toAdminLogEntry,
  toSubscription,
  type AdminLogEntry,
  type AdminLogRow,
  type AdminLogTargetType,
  type Subscription,
  type SubscriptionRow,
} from "./types";
import { newId } from "@/lib/ids";
import { formatMoney } from "@/lib/money";
import type { PlanId } from "@/lib/plans";

/**
 * Read models for the admin panel, plus the audit log.
 *
 * The listing queries aggregate in SQL rather than fetching every user and
 * counting in JavaScript. With a few hundred accounts either works; the
 * difference is that one of them keeps working.
 */

/* ── audit log ──────────────────────────────────────────────────── */

export type AdminActor = { id: string; email: string };

/**
 * Records an administrative action.
 *
 * Every mutating admin path calls this, and the entry is written whether
 * or not anybody ever looks: the value of an audit log is entirely in the
 * cases where something went wrong and nobody remembers who changed what.
 * Rows are never deleted, and survive deletion of the account they refer
 * to — the record that an admin deleted a user has to outlive the user.
 */
export function recordAdminAction(input: {
  admin: AdminActor;
  action: string;
  targetType: AdminLogTargetType;
  targetId?: string | null;
  targetLabel?: string | null;
  detail?: string | null;
}): void {
  run(
    `INSERT INTO admin_logs
       (id, admin_id, admin_email, action, target_type, target_id,
        target_label, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      newId("log"),
      input.admin.id,
      input.admin.email,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.targetLabel ?? null,
      input.detail?.slice(0, 1000) ?? null,
      Date.now(),
    ],
  );
}

export function listAdminLogs(options?: {
  limit?: number;
  targetType?: AdminLogTargetType;
  targetId?: string;
}): AdminLogEntry[] {
  const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
  if (options?.targetId) {
    return many<AdminLogRow>(
      `SELECT * FROM admin_logs WHERE target_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [options.targetId, limit],
    ).map(toAdminLogEntry);
  }
  if (options?.targetType) {
    return many<AdminLogRow>(
      `SELECT * FROM admin_logs WHERE target_type = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [options.targetType, limit],
    ).map(toAdminLogEntry);
  }
  return many<AdminLogRow>(
    "SELECT * FROM admin_logs ORDER BY created_at DESC, rowid DESC LIMIT ?",
    [limit],
  ).map(toAdminLogEntry);
}

export function countAdminLogs(): number {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM admin_logs")?.n ?? 0;
}

/* ── dashboard statistics ───────────────────────────────────────── */

export type AdminStats = {
  users: { total: number; active: number; blocked: number; admins: number };
  plans: Record<PlanId, number>;
  subscriptions: {
    active: number;
    expired: number;
    cancelled: number;
    paid: number;
  };
  websites: number;
  reports: { total: number; complete: number; failed: number; running: number };
  scans: { total: number; successful: number; failed: number };
  /** Verified live INR revenue, in paise. */
  revenuePaise: number;
  /**
   * Verified live revenue per currency, in minor units. Rupees and dollars
   * are never added together — there is no exchange rate in this app.
   */
  revenueByCurrency: { INR: number; USD: number };
  payments: { total: number; paid: number; failed: number };
};

function scalar(sql: string, params: (string | number)[] = []): number {
  return one<{ n: number }>(sql, params)?.n ?? 0;
}

export function adminStats(): AdminStats {
  // A scan and a report are the same event seen twice — one row in
  // `reports` per scan attempted. Deriving the scan counters from report
  // state rather than a separate counter table means the two numbers
  // cannot drift apart.
  const complete = scalar("SELECT COUNT(*) AS n FROM reports WHERE state = 'complete'");
  const failed = scalar("SELECT COUNT(*) AS n FROM reports WHERE state = 'failed'");
  const running = scalar("SELECT COUNT(*) AS n FROM reports WHERE state = 'running'");

  const planCounts: Record<PlanId, number> = { free: 0, basic: 0, pro: 0 };
  for (const row of many<{ plan_id: string; n: number }>(
    `SELECT plan_id, COUNT(*) AS n FROM subscriptions
      WHERE status = 'active' GROUP BY plan_id`,
  )) {
    if (row.plan_id === "free" || row.plan_id === "basic" || row.plan_id === "pro") {
      planCounts[row.plan_id] = row.n;
    }
  }

  return {
    users: {
      total: scalar("SELECT COUNT(*) AS n FROM users"),
      active: scalar("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
      blocked: scalar("SELECT COUNT(*) AS n FROM users WHERE status = 'blocked'"),
      admins: scalar("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
    },
    plans: planCounts,
    subscriptions: {
      active: scalar("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'"),
      expired: scalar("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'expired'"),
      cancelled: scalar("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'cancelled'"),
      paid: scalar("SELECT COUNT(*) AS n FROM subscriptions WHERE payment_status = 'paid'"),
    },
    websites: scalar("SELECT COUNT(*) AS n FROM websites"),
    reports: { total: complete + failed + running, complete, failed, running },
    scans: { total: complete + failed + running, successful: complete, failed },
    // Only verified, real-money payments count. Mock-mode orders exist so
    // the flow can be exercised without keys, and putting them in the
    // revenue figure would make the dashboard lie.
    revenuePaise: scalar(
      `SELECT COALESCE(SUM(amount_paise), 0) AS n FROM payments
        WHERE status = 'paid' AND mode = 'live' AND currency = 'INR'`,
    ),
    revenueByCurrency: {
      INR: scalar(
        `SELECT COALESCE(SUM(amount_paise), 0) AS n FROM payments
          WHERE status = 'paid' AND mode = 'live' AND currency = 'INR'`,
      ),
      USD: scalar(
        `SELECT COALESCE(SUM(amount_paise), 0) AS n FROM payments
          WHERE status = 'paid' AND mode = 'live' AND currency = 'USD'`,
      ),
    },
    payments: {
      total: scalar("SELECT COUNT(*) AS n FROM payments"),
      paid: scalar("SELECT COUNT(*) AS n FROM payments WHERE status = 'paid'"),
      failed: scalar("SELECT COUNT(*) AS n FROM payments WHERE status IN ('failed','cancelled')"),
    },
  };
}

/* ── user listing ───────────────────────────────────────────────── */

export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  createdAt: number;
  lastActiveAt: number | null;
  blockedReason: string | null;
  planId: PlanId | null;
  planName: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  paymentStatus: string | null;
  expiresAt: number | null;
  cycleEnd: number | null;
  scanLimit: number | null;
  scansUsed: number;
  siteLimit: number | null;
  websites: number;
  reports: number;
};

type RawAdminUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  created_at: number;
  last_active_at: number | null;
  blocked_reason: string | null;
  plan_id: string | null;
  plan_name: string | null;
  sub_id: string | null;
  sub_status: string | null;
  payment_status: string | null;
  expires_at: number | null;
  cycle_end: number | null;
  scan_limit: number | null;
  scans_used: number | null;
  site_limit: number | null;
  websites: number;
  reports: number;
};

/**
 * The admin user table, one row per account, with the live subscription
 * joined on.
 *
 * The subscription is picked by `purchased_at DESC` among active rows, the
 * same rule `getActiveSubscription` uses. Two places deciding "which
 * subscription counts" by different rules is how an admin ends up looking
 * at a plan the user does not have.
 */
export function listAdminUsers(options?: {
  search?: string;
  plan?: PlanId | "none";
  status?: "active" | "blocked";
  limit?: number;
  offset?: number;
}): AdminUserRow[] {
  const limit = Math.min(200, Math.max(1, options?.limit ?? 50));
  const offset = Math.max(0, options?.offset ?? 0);
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options?.search) {
    where.push("(u.name LIKE ? OR u.email LIKE ?)");
    const like = `%${options.search.trim()}%`;
    params.push(like, like);
  }
  if (options?.status) {
    where.push("u.status = ?");
    params.push(options.status);
  }
  if (options?.plan === "none") {
    where.push("s.id IS NULL");
  } else if (options?.plan) {
    where.push("s.plan_id = ?");
    params.push(options.plan);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  // Safe interpolation: `clause` is assembled from the literals above and
  // every user-supplied value is a bound parameter.
  const rows = many<RawAdminUser>(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at,
            u.last_active_at, u.blocked_reason,
            s.id            AS sub_id,
            s.plan_id       AS plan_id,
            s.plan_name     AS plan_name,
            s.status        AS sub_status,
            s.payment_status AS payment_status,
            s.expires_at    AS expires_at,
            s.cycle_end     AS cycle_end,
            s.scan_limit    AS scan_limit,
            s.scans_used    AS scans_used,
            s.site_limit    AS site_limit,
            (SELECT COUNT(*) FROM websites w WHERE w.user_id = u.id) AS websites,
            (SELECT COUNT(*) FROM reports r  WHERE r.user_id = u.id) AS reports
       FROM users u
       LEFT JOIN subscriptions s
              ON s.id = (
                   SELECT s2.id FROM subscriptions s2
                    WHERE s2.user_id = u.id AND s2.status = 'active'
                    ORDER BY s2.purchased_at DESC LIMIT 1
                 )
       ${clause}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    blockedReason: row.blocked_reason,
    planId: (row.plan_id as PlanId | null) ?? null,
    planName: row.plan_name,
    subscriptionId: row.sub_id,
    subscriptionStatus: row.sub_status,
    paymentStatus: row.payment_status,
    expiresAt: row.expires_at,
    cycleEnd: row.cycle_end,
    scanLimit: row.scan_limit,
    scansUsed: row.scans_used ?? 0,
    siteLimit: row.site_limit,
    websites: row.websites,
    reports: row.reports,
  }));
}

export function countAdminUsers(options?: {
  search?: string;
  status?: "active" | "blocked";
}): number {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options?.search) {
    where.push("(name LIKE ? OR email LIKE ?)");
    const like = `%${options.search.trim()}%`;
    params.push(like, like);
  }
  if (options?.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return scalar(`SELECT COUNT(*) AS n FROM users ${clause}`, params);
}

/* ── subscription listing ───────────────────────────────────────── */

export type AdminSubscription = Subscription & {
  userName: string;
  userEmail: string;
};

export function listAllSubscriptions(options?: {
  status?: "active" | "expired" | "cancelled";
  planId?: PlanId;
  limit?: number;
}): AdminSubscription[] {
  const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options?.status) {
    where.push("s.status = ?");
    params.push(options.status);
  }
  if (options?.planId) {
    where.push("s.plan_id = ?");
    params.push(options.planId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  const rows = many<SubscriptionRow & { user_name: string; user_email: string }>(
    `SELECT s.*, u.name AS user_name, u.email AS user_email
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       ${clause}
       ORDER BY s.purchased_at DESC
       LIMIT ?`,
    params,
  );

  return rows.map((row) => ({
    ...toSubscription(row),
    userName: row.user_name,
    userEmail: row.user_email,
  }));
}

/* ── payment listing ────────────────────────────────────────────── */

export type AdminPayment = {
  id: string;
  userName: string;
  userEmail: string;
  planId: string;
  amountPaise: number;
  currency: string;
  status: string;
  gateway: string;
  mode: string;
  environment: string | null;
  orderId: string;
  paymentId: string | null;
  failureReason: string | null;
  createdAt: number;
  verifiedAt: number | null;
};

export function listAllPayments(options?: {
  status?: string;
  gateway?: string;
  limit?: number;
}): AdminPayment[] {
  const limit = Math.min(500, Math.max(1, options?.limit ?? 100));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options?.status) {
    where.push("p.status = ?");
    params.push(options.status);
  }
  if (options?.gateway) {
    where.push("p.gateway = ?");
    params.push(options.gateway);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  return many<{
    id: string;
    user_name: string;
    user_email: string;
    plan_id: string;
    amount_paise: number;
    currency: string;
    status: string;
    gateway: string;
    mode: string;
    environment: string | null;
    gateway_order_id: string;
    gateway_payment_id: string | null;
    failure_reason: string | null;
    created_at: number;
    verified_at: number | null;
  }>(
    `SELECT p.id, u.name AS user_name, u.email AS user_email, p.plan_id,
            p.amount_paise, p.currency, p.status, p.gateway, p.mode,
            p.environment, p.gateway_order_id, p.gateway_payment_id,
            p.failure_reason, p.created_at, p.verified_at
       FROM payments p
       JOIN users u ON u.id = p.user_id
       ${clause}
       ORDER BY p.created_at DESC
       LIMIT ?`,
    params,
  ).map((row) => ({
    id: row.id,
    userName: row.user_name,
    userEmail: row.user_email,
    planId: row.plan_id,
    amountPaise: row.amount_paise,
    currency: row.currency,
    status: row.status,
    gateway: row.gateway,
    mode: row.mode,
    environment: row.environment,
    orderId: row.gateway_order_id,
    paymentId: row.gateway_payment_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  }));
}

/* ── recent activity ────────────────────────────────────────────── */

export type ActivityEntry = {
  kind: "signup" | "scan" | "payment" | "admin";
  at: number;
  title: string;
  detail: string;
};

/**
 * A merged, most-recent-first feed of the things that happen in the
 * product. Four small queries beat one large UNION here: each is
 * index-backed, and the merge of at most 40 rows costs nothing.
 */
export function recentActivity(limit = 12): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const row of many<{ name: string; email: string; created_at: number }>(
    "SELECT name, email, created_at FROM users ORDER BY created_at DESC LIMIT 10",
  )) {
    entries.push({
      kind: "signup",
      at: row.created_at,
      title: `${row.name} signed up`,
      detail: row.email,
    });
  }

  for (const row of many<{
    domain: string;
    state: string;
    score: number;
    created_at: number;
    email: string;
  }>(
    `SELECT r.domain, r.state, r.score, r.created_at, u.email
       FROM reports r JOIN users u ON u.id = r.user_id
      ORDER BY r.created_at DESC LIMIT 10`,
  )) {
    entries.push({
      kind: "scan",
      at: row.created_at,
      title:
        row.state === "complete"
          ? `${row.domain} scored ${row.score}`
          : row.state === "failed"
            ? `${row.domain} scan failed`
            : `${row.domain} scan running`,
      detail: row.email,
    });
  }

  for (const row of many<{
    amount_paise: number;
    currency: string;
    status: string;
    gateway: string;
    created_at: number;
    email: string;
  }>(
    `SELECT p.amount_paise, p.currency, p.status, p.gateway, p.created_at, u.email
       FROM payments p JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC LIMIT 10`,
  )) {
    entries.push({
      kind: "payment",
      at: row.created_at,
      // Each payment in the currency it was made in.
      title: `${formatMoney(row.amount_paise, row.currency)} ${row.status} via ${row.gateway}`,
      detail: row.email,
    });
  }

  for (const entry of listAdminLogs({ limit: 10 })) {
    entries.push({
      kind: "admin",
      at: entry.createdAt,
      title: `${entry.action}${entry.targetLabel ? ` — ${entry.targetLabel}` : ""}`,
      detail: entry.adminEmail,
    });
  }

  return entries.sort((a, b) => b.at - a.at).slice(0, limit);
}
