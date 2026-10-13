import { many } from "@/lib/db";
import { VERDICT_LABEL } from "@/lib/analysis/types";
import type { Currency } from "@/lib/money";
import { getPlan } from "@/lib/plan-catalogue";
import { clampPage, nullableScalar, perBucket, ratio, scalar, type Page, type Ranked, type Window } from "./common";
import { addMonths, localDateOf, localMidnight, type Bucket } from "./time";

/**
 * Figures read from the application's own records — accounts, scan
 * reports, payments, subscriptions, checkouts, webhooks and alert
 * deliveries. These cover history from before analytics tracking
 * existed, and they are the source of truth wherever money, accounts or
 * scan outcomes are concerned.
 *
 * Revenue rules: only payments the server verified (`status = 'paid'`)
 * in live mode count; test-mode (mock) orders never do. Each payment row
 * is one order, and a webhook or a second verify for the same order
 * cannot create another row or change the amount, so nothing is counted
 * twice. Amounts stay in their own currency; rupees and dollars are
 * never added together.
 */

const CURRENCIES: Currency[] = ["INR", "USD"];
const PAID_AT = "COALESCE(verified_at, updated_at)";

export type MoneyByCurrency = Record<Currency, number>;

function moneyRows(sql: string, params: (string | number)[]): MoneyByCurrency {
  const out: MoneyByCurrency = { INR: 0, USD: 0 };
  for (const row of many<{ currency: string; n: number }>(sql, params)) {
    if (row.currency === "INR" || row.currency === "USD") out[row.currency] = Number(row.n ?? 0);
  }
  return out;
}

/* ── headline business figures (overview) ───────────────────────── */

export type BusinessTotals = {
  signups: number;
  verified: number;
  checkoutDetailsSaved: number;
  purchases: number;
  revenue: MoneyByCurrency;
  scansStarted: number;
  scansCompleted: number;
  scansFailed: number;
  scanFailureRate: number | null;
};

export function businessTotals(w: Window): BusinessTotals {
  const p = [w.start, w.end];
  const complete = scalar("SELECT COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ? AND state = 'complete'", p);
  const failed = scalar("SELECT COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ? AND state = 'failed'", p);
  return {
    signups: scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND created_at >= ? AND created_at < ?", p),
    verified: scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND email_verified_at >= ? AND email_verified_at < ?", p),
    checkoutDetailsSaved: scalar("SELECT COUNT(*) AS n FROM checkout_sessions WHERE created_at >= ? AND created_at < ?", p),
    purchases: scalar(`SELECT COUNT(*) AS n FROM payments WHERE status = 'paid' AND mode = 'live' AND ${PAID_AT} >= ? AND ${PAID_AT} < ?`, p),
    revenue: moneyRows(
      `SELECT currency, SUM(amount_paise) AS n FROM payments
        WHERE status = 'paid' AND mode = 'live' AND ${PAID_AT} >= ? AND ${PAID_AT} < ? GROUP BY currency`,
      p,
    ),
    scansStarted: scalar("SELECT COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ?", p),
    scansCompleted: complete,
    scansFailed: failed,
    scanFailureRate: ratio(failed, complete + failed),
  };
}

export function businessSeries(list: Bucket[]) {
  return {
    signups: perBucket({ list, from: "users t", ts: "t.created_at", agg: "COUNT(t.id)", where: "t.role <> 'admin'" }),
    scans: perBucket({ list, from: "reports t", ts: "t.created_at", agg: "COUNT(t.id)" }),
    purchases: perBucket({ list, from: "payments t", ts: "COALESCE(t.verified_at, t.updated_at)", agg: "COUNT(t.id)", where: "t.status = 'paid' AND t.mode = 'live'" }),
  };
}

/* ── accounts ───────────────────────────────────────────────────── */

const ACTIVE_UNION = `
  SELECT user_id AS id FROM reports WHERE created_at >= ? AND created_at < ?
  UNION SELECT user_id FROM payments WHERE created_at >= ? AND created_at < ?
  UNION SELECT user_id FROM analytics_events WHERE user_id IS NOT NULL AND internal = 0 AND occurred_at >= ? AND occurred_at < ?`;

export type AccountsReport = {
  totalUsers: number;
  newUsers: number;
  verifiedInPeriod: number;
  verificationNotRecorded: number;
  activeUsers: number;
  returningUsers: number;
  signupForms: number;
  emailVerifications: number;
  verificationCompletion: number | null;
  registrations: number[];
  activeSeries: number[];
  subscriptionChanges: { firstPurchase: number; repeatPurchase: number; adminAssigned: number; expired: number; cancelled: number };
  recent: { id: string; name: string; createdAt: number; verifiedAt: number | null }[];
};

export function accountsReport(w: Window, list: Bucket[], now: number): AccountsReport {
  const p = [w.start, w.end];
  const active = many<{ id: string; created_at: number | null; role: string | null }>(
    `SELECT a.id, u.created_at, u.role FROM (${ACTIVE_UNION}) a JOIN users u ON u.id = a.id`,
    [...p, ...p, ...p],
  ).filter((r) => r.role !== "admin");
  const signupForms = scalar("SELECT COUNT(*) AS n FROM analytics_events WHERE name = 'signup_completed' AND occurred_at >= ? AND occurred_at < ?", p);
  const emailVerifications = scalar("SELECT COUNT(*) AS n FROM analytics_events WHERE name = 'email_verified' AND occurred_at >= ? AND occurred_at < ?", p);

  const activeSeries = list.length
    ? perBucket({
        list,
        from: `(${`SELECT user_id, created_at AS ts FROM reports
                  UNION ALL SELECT user_id, created_at FROM payments
                  UNION ALL SELECT user_id, occurred_at FROM analytics_events WHERE user_id IS NOT NULL AND internal = 0`}) t`,
        ts: "t.ts",
        agg: "COUNT(DISTINCT t.user_id)",
        where: "t.user_id IN (SELECT id FROM users WHERE role <> 'admin')",
      })
    : [];

  const purchases = many<{ id: string; prior: number }>(
    `SELECT s.id, EXISTS (SELECT 1 FROM subscriptions o WHERE o.user_id = s.user_id AND o.order_id IS NOT NULL AND o.created_at < s.created_at) AS prior
       FROM subscriptions s WHERE s.order_id IS NOT NULL AND s.created_at >= ? AND s.created_at < ?`,
    p,
  );

  return {
    totalUsers: scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND created_at < ?", [w.end]),
    newUsers: scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND created_at >= ? AND created_at < ?", p),
    verifiedInPeriod: scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND email_verified_at >= ? AND email_verified_at < ?", p),
    verificationNotRecorded: scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND email_verified_at IS NULL AND created_at < ?", [w.end]),
    activeUsers: active.length,
    returningUsers: active.filter((r) => (r.created_at ?? 0) < w.start).length,
    signupForms,
    emailVerifications,
    verificationCompletion: ratio(emailVerifications, signupForms),
    registrations: perBucket({ list, from: "users t", ts: "t.created_at", agg: "COUNT(t.id)", where: "t.role <> 'admin'" }),
    activeSeries,
    subscriptionChanges: {
      firstPurchase: purchases.filter((r) => !r.prior).length,
      repeatPurchase: purchases.filter((r) => r.prior).length,
      adminAssigned: scalar(
        "SELECT COUNT(*) AS n FROM subscriptions WHERE order_id IS NULL AND plan_id <> 'free' AND created_at >= ? AND created_at < ?",
        p,
      ),
      expired: scalar("SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id <> 'free' AND expires_at >= ? AND expires_at < ? AND expires_at <= ?", [...p, now]),
      cancelled: scalar("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'cancelled' AND updated_at >= ? AND updated_at < ?", p),
    },
    recent: many<{ id: string; name: string; created_at: number; email_verified_at: number | null }>(
      "SELECT id, name, created_at, email_verified_at FROM users WHERE role <> 'admin' ORDER BY created_at DESC LIMIT 8",
    ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, verifiedAt: r.email_verified_at })),
  };
}

export type CohortRow = { label: string; size: number; months: (number | null)[] };

/**
 * Registration cohorts by calendar month (reporting timezone) and the
 * share of each cohort that ran at least one scan in each following
 * month. Scans are the activity used because they are recorded for every
 * account since launch; null marks a month that has not happened yet.
 */
export function cohorts(tz: string, now: number, monthsBack = 6, horizon = 3): CohortRow[] {
  const today = localDateOf(now, tz);
  const thisMonth = { y: today.y, m: today.m, d: 1 };
  const out: CohortRow[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const cohortStart = addMonths(thisMonth, -i);
    const s = localMidnight(cohortStart, tz);
    const e = localMidnight(addMonths(cohortStart, 1), tz);
    const size = scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin' AND created_at >= ? AND created_at < ?", [s, e]);
    const months: (number | null)[] = [];
    for (let k = 1; k <= horizon; k++) {
      const ms = localMidnight(addMonths(cohortStart, k), tz);
      const me = localMidnight(addMonths(cohortStart, k + 1), tz);
      if (ms > now || size === 0) {
        months.push(null);
        continue;
      }
      const retained = scalar(
        `SELECT COUNT(*) AS n FROM users u WHERE u.role <> 'admin' AND u.created_at >= ? AND u.created_at < ?
           AND EXISTS (SELECT 1 FROM reports r WHERE r.user_id = u.id AND r.created_at >= ? AND r.created_at < ?)`,
        [s, e, ms, me],
      );
      months.push(retained / size);
    }
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    out.push({ label: `${MONTHS[cohortStart.m - 1]} ${cohortStart.y}`, size, months });
  }
  return out;
}

export type UserRow = {
  id: string;
  name: string;
  email: string;
  createdAt: number;
  verifiedAt: number | null;
  lastActivityAt: number | null;
  planName: string | null;
  subscriptionStatus: string | null;
  accountStatus: string;
  scans: number;
};

/**
 * Accounts, newest first. "Last activity" is the latest scan, payment or
 * signed-in tracked visit on record — the app has never stored a general
 * last-seen time, so nothing older than those records can be shown.
 */
export function usersTable(options: { page?: unknown; pageSize?: number; limit?: number }): Page<UserRow> {
  const pageSize = options.limit ?? options.pageSize ?? 25;
  const total = scalar("SELECT COUNT(*) AS n FROM users WHERE role <> 'admin'");
  const page = options.limit ? 1 : clampPage(options.page, pageSize, total);
  const rows = many<{
    id: string; name: string; email: string; created_at: number; email_verified_at: number | null; status: string;
    last_scan: number | null; last_pay: number | null; last_event: number | null; plan_name: string | null; sub_status: string | null; scans: number;
  }>(
    `SELECT u.id, u.name, u.email, u.created_at, u.email_verified_at, u.status,
            (SELECT MAX(created_at) FROM reports r WHERE r.user_id = u.id) AS last_scan,
            (SELECT MAX(created_at) FROM payments p WHERE p.user_id = u.id) AS last_pay,
            (SELECT MAX(occurred_at) FROM analytics_events e WHERE e.user_id = u.id AND e.internal = 0) AS last_event,
            (SELECT plan_name FROM subscriptions s WHERE s.user_id = u.id ORDER BY s.purchased_at DESC LIMIT 1) AS plan_name,
            (SELECT status FROM subscriptions s WHERE s.user_id = u.id ORDER BY s.purchased_at DESC LIMIT 1) AS sub_status,
            (SELECT COUNT(*) FROM reports r WHERE r.user_id = u.id) AS scans
       FROM users u
      WHERE u.role <> 'admin'
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?`,
    [pageSize, (page - 1) * pageSize],
  );
  return {
    rows: rows.map((r) => {
      const candidates = [r.last_scan, r.last_pay, r.last_event].filter((x): x is number => typeof x === "number");
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        createdAt: r.created_at,
        verifiedAt: r.email_verified_at,
        lastActivityAt: candidates.length ? Math.max(...candidates) : null,
        planName: r.plan_name,
        subscriptionStatus: r.sub_status,
        accountStatus: r.status,
        scans: Number(r.scans),
      };
    }),
    total,
    page,
    pageSize,
  };
}

/* ── scans ──────────────────────────────────────────────────────── */

export type ScansReport = {
  started: number;
  completed: number;
  failed: number;
  running: number;
  completionRate: number | null;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  series: { started: number[]; completed: number[]; failed: number[] };
  verdicts: Ranked[];
  scoreBands: Ranked[];
  freeVsPaid: Ranked[];
  byPlan: Ranked[];
  repeatUsage: Ranked[];
  scanners: number;
  failureReasons: Ranked[];
  demoFallbacks: number;
  trackedFailures: number;
  blocked: Ranked[];
  freeScanners: number;
  freeScannersWhoPaid: number;
};

const BLOCK_LABEL: Record<string, string> = {
  LIMIT_REACHED: "Monthly scan limit reached",
  SITE_LIMIT_REACHED: "Website limit reached",
  NO_ACTIVE_PLAN: "No active plan",
  PLAN_EXPIRED: "Plan expired",
};

export function scansReport(w: Window, list: Bucket[]): ScansReport {
  const p = [w.start, w.end];
  const counts = many<{ state: string; n: number }>(
    "SELECT state, COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ? GROUP BY state",
    p,
  );
  const by = (state: string) => Number(counts.find((c) => c.state === state)?.n ?? 0);
  const completed = by("complete");
  const failed = by("failed");
  const running = by("running");
  const durations = scalar("SELECT COUNT(*) AS n FROM reports WHERE state = 'complete' AND duration_ms IS NOT NULL AND created_at >= ? AND created_at < ?", p);
  const median =
    durations > 0
      ? nullableScalar(
          `SELECT duration_ms AS n FROM reports WHERE state = 'complete' AND duration_ms IS NOT NULL AND created_at >= ? AND created_at < ?
            ORDER BY duration_ms LIMIT 1 OFFSET ?`,
          [...p, Math.floor((durations - 1) / 2)],
        )
      : null;

  const perUser = many<{ user_id: string; n: number }>(
    "SELECT user_id, COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ? GROUP BY user_id",
    p,
  );
  const band = (lo: number, hi: number) => perUser.filter((u) => u.n >= lo && u.n <= hi).length;

  const freeScanners = scalar(
    "SELECT COUNT(DISTINCT user_id) AS n FROM reports WHERE plan_id = 'free' AND created_at >= ? AND created_at < ?",
    p,
  );
  const freeScannersWhoPaid = scalar(
    `SELECT COUNT(*) AS n FROM (
        SELECT user_id, MIN(created_at) AS first_free FROM reports
         WHERE plan_id = 'free' AND created_at >= ? AND created_at < ? GROUP BY user_id
      ) f
      WHERE EXISTS (SELECT 1 FROM payments p WHERE p.user_id = f.user_id AND p.status = 'paid' AND p.mode = 'live'
                     AND COALESCE(p.verified_at, p.updated_at) > f.first_free)`,
    p,
  );

  return {
    started: completed + failed + running,
    completed,
    failed,
    running,
    completionRate: ratio(completed, completed + failed),
    avgDurationMs: durations ? nullableScalar("SELECT AVG(duration_ms) AS n FROM reports WHERE state = 'complete' AND duration_ms IS NOT NULL AND created_at >= ? AND created_at < ?", p) : null,
    medianDurationMs: median,
    series: {
      started: perBucket({ list, from: "reports t", ts: "t.created_at", agg: "COUNT(t.id)" }),
      completed: perBucket({ list, from: "reports t", ts: "t.created_at", agg: "COUNT(t.id)", where: "t.state = 'complete'" }),
      failed: perBucket({ list, from: "reports t", ts: "t.created_at", agg: "COUNT(t.id)", where: "t.state = 'failed'" }),
    },
    verdicts: many<{ verdict: string | null; n: number }>(
      "SELECT verdict, COUNT(*) AS n FROM reports WHERE state = 'complete' AND created_at >= ? AND created_at < ? GROUP BY verdict ORDER BY n DESC",
      p,
    ).map((r) => ({ label: r.verdict ? (VERDICT_LABEL as Record<string, string>)[r.verdict] ?? r.verdict : "No verdict", value: Number(r.n) })),
    scoreBands: many<{ band: string; n: number }>(
      `SELECT CASE WHEN score >= 85 THEN '85–100' WHEN score >= 70 THEN '70–84' WHEN score >= 50 THEN '50–69' ELSE '0–49' END AS band,
              COUNT(*) AS n
         FROM reports WHERE state = 'complete' AND score IS NOT NULL AND created_at >= ? AND created_at < ?
        GROUP BY band ORDER BY band DESC`,
      p,
    ).map((r) => ({ label: `Score ${r.band}`, value: Number(r.n) })),
    freeVsPaid: many<{ kind: string; n: number }>(
      "SELECT CASE WHEN plan_id = 'free' THEN 'Free plan' ELSE 'Paid plans' END AS kind, COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ? GROUP BY kind ORDER BY n DESC",
      p,
    ).map((r) => ({ label: r.kind, value: Number(r.n) })),
    byPlan: many<{ plan: string | null; n: number; users: number }>(
      "SELECT plan_name AS plan, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM reports WHERE created_at >= ? AND created_at < ? GROUP BY plan_name ORDER BY n DESC",
      p,
    ).map((r) => ({ label: r.plan ?? "Unknown", value: Number(r.n), secondary: Number(r.users) })),
    repeatUsage: [
      { label: "1 scan", value: band(1, 1) },
      { label: "2–3 scans", value: band(2, 3) },
      { label: "4–9 scans", value: band(4, 9) },
      { label: "10 or more", value: band(10, Number.MAX_SAFE_INTEGER) },
    ],
    scanners: perUser.length,
    failureReasons: many<{ msg: string | null; n: number }>(
      `SELECT COALESCE(error_message, 'No reason recorded') AS msg, COUNT(*) AS n FROM reports
        WHERE state = 'failed' AND created_at >= ? AND created_at < ? GROUP BY msg ORDER BY n DESC LIMIT 8`,
      p,
    ).map((r) => ({ label: (r.msg ?? "").slice(0, 160), value: Number(r.n) })),
    demoFallbacks: scalar("SELECT COUNT(*) AS n FROM reports WHERE analysis_mode = 'demo' AND created_at >= ? AND created_at < ?", p),
    trackedFailures: scalar("SELECT COUNT(*) AS n FROM analytics_events WHERE name = 'scan_failed' AND occurred_at >= ? AND occurred_at < ?", p),
    blocked: many<{ reason: string | null; n: number }>(
      `SELECT json_extract(props_json, '$.reason') AS reason, COUNT(*) AS n FROM analytics_events
        WHERE name = 'scan_blocked' AND occurred_at >= ? AND occurred_at < ? GROUP BY reason ORDER BY n DESC`,
      p,
    ).map((r) => ({ label: BLOCK_LABEL[r.reason ?? ""] ?? r.reason ?? "Other", value: Number(r.n) })),
    freeScanners,
    freeScannersWhoPaid,
  };
}

/* ── revenue ────────────────────────────────────────────────────── */

export type RevenueReport = {
  gross: MoneyByCurrency;
  refunds: null;
  net: MoneyByCurrency;
  paidCount: number;
  failedCount: number;
  cancelledCount: number;
  pendingCount: number;
  successRate: number | null;
  testModePaid: number;
  series: Record<Currency, number[]>;
  countSeries: number[];
  byPlan: { plan: string; currency: Currency; amount: number; count: number }[];
  byGateway: { gateway: string; currency: Currency; amount: number; count: number }[];
  newCustomers: number;
  returningCustomers: number;
  failureSeries: number[];
  checkoutSeries: { saved: number[]; abandoned: number[] };
  abandoned: number;
  checkouts: number;
};

export function revenueReport(w: Window, list: Bucket[]): RevenueReport {
  const p = [w.start, w.end];
  const gross = moneyRows(
    `SELECT currency, SUM(amount_paise) AS n FROM payments
      WHERE status = 'paid' AND mode = 'live' AND ${PAID_AT} >= ? AND ${PAID_AT} < ? GROUP BY currency`,
    p,
  );
  const outcome = (status: string) =>
    scalar(`SELECT COUNT(*) AS n FROM payments WHERE mode = 'live' AND status = ? AND ${status === "created" ? "created_at" : "updated_at"} >= ? AND ${status === "created" ? "created_at" : "updated_at"} < ?`, [status, ...p]);
  const paidCount = scalar(`SELECT COUNT(*) AS n FROM payments WHERE status = 'paid' AND mode = 'live' AND ${PAID_AT} >= ? AND ${PAID_AT} < ?`, p);
  const failedCount = outcome("failed");
  const cancelledCount = outcome("cancelled");

  // Success rate over orders opened in the period that reached an outcome.
  const settled = many<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM payments WHERE mode = 'live' AND created_at >= ? AND created_at < ? AND status IN ('paid','failed','cancelled') GROUP BY status",
    p,
  );
  const settledTotal = settled.reduce((sum, r) => sum + Number(r.n), 0);
  const settledPaid = Number(settled.find((r) => r.status === "paid")?.n ?? 0);

  const series = {} as Record<Currency, number[]>;
  for (const currency of CURRENCIES) {
    series[currency] = perBucket({
      list,
      from: "payments t",
      ts: "COALESCE(t.verified_at, t.updated_at)",
      agg: "COALESCE(SUM(t.amount_paise), 0)",
      where: "t.status = 'paid' AND t.mode = 'live' AND t.currency = ?",
      params: [currency],
    });
  }

  const paidRows = many<{ user_id: string; first_paid: number; at: number }>(
    `SELECT p.user_id,
            (SELECT MIN(COALESCE(o.verified_at, o.updated_at)) FROM payments o WHERE o.user_id = p.user_id AND o.status = 'paid' AND o.mode = 'live') AS first_paid,
            COALESCE(p.verified_at, p.updated_at) AS at
       FROM payments p
      WHERE p.status = 'paid' AND p.mode = 'live' AND COALESCE(p.verified_at, p.updated_at) >= ? AND COALESCE(p.verified_at, p.updated_at) < ?`,
    p,
  );
  const customers = new Map<string, boolean>();
  for (const row of paidRows) {
    const isNew = Number(row.first_paid) >= w.start;
    customers.set(row.user_id, (customers.get(row.user_id) ?? false) || isNew);
  }

  const planName = (id: string) => getPlan(id)?.name ?? id;

  return {
    gross,
    refunds: null,
    net: { ...gross },
    paidCount,
    failedCount,
    cancelledCount,
    pendingCount: outcome("created"),
    successRate: ratio(settledPaid, settledTotal),
    testModePaid: scalar(`SELECT COUNT(*) AS n FROM payments WHERE status = 'paid' AND mode <> 'live' AND ${PAID_AT} >= ? AND ${PAID_AT} < ?`, p),
    series,
    countSeries: perBucket({ list, from: "payments t", ts: "COALESCE(t.verified_at, t.updated_at)", agg: "COUNT(t.id)", where: "t.status = 'paid' AND t.mode = 'live'" }),
    byPlan: many<{ plan_id: string; currency: Currency; amount: number; n: number }>(
      `SELECT plan_id, currency, SUM(amount_paise) AS amount, COUNT(*) AS n FROM payments
        WHERE status = 'paid' AND mode = 'live' AND ${PAID_AT} >= ? AND ${PAID_AT} < ?
        GROUP BY plan_id, currency ORDER BY currency, amount DESC`,
      p,
    ).map((r) => ({ plan: planName(r.plan_id), currency: r.currency, amount: Number(r.amount), count: Number(r.n) })),
    byGateway: many<{ gateway: string | null; currency: Currency; amount: number; n: number }>(
      `SELECT gateway, currency, SUM(amount_paise) AS amount, COUNT(*) AS n FROM payments
        WHERE status = 'paid' AND mode = 'live' AND ${PAID_AT} >= ? AND ${PAID_AT} < ?
        GROUP BY gateway, currency ORDER BY currency, amount DESC`,
      p,
    ).map((r) => ({ gateway: r.gateway ?? "razorpay", currency: r.currency, amount: Number(r.amount), count: Number(r.n) })),
    newCustomers: [...customers.values()].filter(Boolean).length,
    returningCustomers: [...customers.values()].filter((v) => !v).length,
    failureSeries: perBucket({ list, from: "payments t", ts: "t.updated_at", agg: "COUNT(t.id)", where: "t.status = 'failed' AND t.mode = 'live'" }),
    checkoutSeries: {
      saved: perBucket({ list, from: "checkout_sessions t", ts: "t.created_at", agg: "COUNT(t.id)" }),
      abandoned: perBucket({ list, from: "checkout_sessions t", ts: "t.abandoned_at", agg: "COUNT(t.id)", where: "t.status = 'abandoned'" }),
    },
    abandoned: scalar("SELECT COUNT(*) AS n FROM checkout_sessions WHERE status = 'abandoned' AND abandoned_at >= ? AND abandoned_at < ?", p),
    checkouts: scalar("SELECT COUNT(*) AS n FROM checkout_sessions WHERE created_at >= ? AND created_at < ?", p),
  };
}

/* ── website health ─────────────────────────────────────────────── */

export type HealthEvent = { at: number; service: string; what: string; detail: string };

export type HealthReport = {
  paymentFailures: number;
  paymentFailureSeries: number[];
  paymentFailureReasons: Ranked[];
  webhooks: Ranked[];
  webhookRejected: number;
  emailStatus: Ranked[];
  emailFailures: number;
  scanFailures: number;
  scanFailureSeries: number[];
  abandonedCheckouts: number;
  recent: HealthEvent[];
};

const WEBHOOK_LABEL: Record<string, string> = {
  processed: "Processed",
  duplicate: "Duplicate delivery (ignored safely)",
  ignored: "Acknowledged, no action",
  rejected: "Rejected (bad signature or data)",
};

const EMAIL_LABEL: Record<string, string> = {
  sent: "Sent",
  pending: "Queued",
  sending: "Sending",
  retry: "Waiting to retry",
  failed: "Failed",
  skipped: "Not sent (no address)",
};

/**
 * Health signals the app already records: failed payments, rejected
 * webhooks, alert-email deliveries, failed scans and abandoned
 * checkouts. Details shown are the app's own short messages — no
 * customer contact details, keys, tokens or cookies.
 */
export function healthReport(w: Window, list: Bucket[]): HealthReport {
  const p = [w.start, w.end];
  const recent: HealthEvent[] = [
    ...many<{ at: number; gateway: string | null; reason: string | null; status: string }>(
      "SELECT updated_at AS at, gateway, failure_reason AS reason, status FROM payments WHERE status IN ('failed','cancelled') AND mode = 'live' AND updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC LIMIT 15",
      p,
    ).map((r) => ({ at: r.at, service: "Payments", what: r.status === "failed" ? `Payment failed (${r.gateway ?? "gateway"})` : `Payment cancelled (${r.gateway ?? "gateway"})`, detail: (r.reason ?? "").slice(0, 160) })),
    ...many<{ at: number; gateway: string; type: string | null; detail: string | null }>(
      "SELECT received_at AS at, gateway, event_type AS type, detail FROM webhook_events WHERE outcome = 'rejected' AND received_at >= ? AND received_at < ? ORDER BY received_at DESC LIMIT 15",
      p,
    ).map((r) => ({ at: r.at, service: "Webhooks", what: `Rejected ${r.gateway} webhook`, detail: `${r.type ?? ""} ${(r.detail ?? "").slice(0, 120)}`.trim() })),
    ...many<{ at: number; type: string; error: string | null; status: string }>(
      "SELECT updated_at AS at, type, last_error AS error, status FROM notifications WHERE status IN ('failed','retry') AND updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC LIMIT 15",
      p,
    ).map((r) => ({ at: r.at, service: "Email", what: `Alert email ${r.status === "failed" ? "failed" : "retrying"} (${r.type.replace("_", " ")})`, detail: (r.error ?? "").slice(0, 160) })),
    ...many<{ at: number; msg: string | null }>(
      "SELECT COALESCE(finished_at, created_at) AS at, error_message AS msg FROM reports WHERE state = 'failed' AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 15",
      p,
    ).map((r) => ({ at: r.at, service: "Scans", what: "Scan failed", detail: (r.msg ?? "").slice(0, 160) })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 25);

  return {
    paymentFailures: scalar("SELECT COUNT(*) AS n FROM payments WHERE status = 'failed' AND mode = 'live' AND updated_at >= ? AND updated_at < ?", p),
    paymentFailureSeries: perBucket({ list, from: "payments t", ts: "t.updated_at", agg: "COUNT(t.id)", where: "t.status = 'failed' AND t.mode = 'live'" }),
    paymentFailureReasons: many<{ reason: string | null; n: number }>(
      "SELECT COALESCE(failure_reason, 'No reason given') AS reason, COUNT(*) AS n FROM payments WHERE status = 'failed' AND mode = 'live' AND updated_at >= ? AND updated_at < ? GROUP BY reason ORDER BY n DESC LIMIT 8",
      p,
    ).map((r) => ({ label: (r.reason ?? "").slice(0, 160), value: Number(r.n) })),
    webhooks: many<{ outcome: string; n: number }>(
      "SELECT outcome, COUNT(*) AS n FROM webhook_events WHERE received_at >= ? AND received_at < ? GROUP BY outcome ORDER BY n DESC",
      p,
    ).map((r) => ({ label: WEBHOOK_LABEL[r.outcome] ?? r.outcome, value: Number(r.n) })),
    webhookRejected: scalar("SELECT COUNT(*) AS n FROM webhook_events WHERE outcome = 'rejected' AND received_at >= ? AND received_at < ?", p),
    emailStatus: many<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM notifications WHERE created_at >= ? AND created_at < ? GROUP BY status ORDER BY n DESC",
      p,
    ).map((r) => ({ label: EMAIL_LABEL[r.status] ?? r.status, value: Number(r.n) })),
    emailFailures: scalar("SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed' AND updated_at >= ? AND updated_at < ?", p),
    scanFailures: scalar("SELECT COUNT(*) AS n FROM reports WHERE state = 'failed' AND created_at >= ? AND created_at < ?", p),
    scanFailureSeries: perBucket({ list, from: "reports t", ts: "t.created_at", agg: "COUNT(t.id)", where: "t.state = 'failed'" }),
    abandonedCheckouts: scalar("SELECT COUNT(*) AS n FROM checkout_sessions WHERE status = 'abandoned' AND abandoned_at >= ? AND abandoned_at < ?", p),
    recent,
  };
}
