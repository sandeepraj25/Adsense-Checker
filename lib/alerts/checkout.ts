import { many, one, run } from "@/lib/db";
import { newId } from "@/lib/ids";

/**
 * Checkout progress: the billing details a signed-in customer has entered
 * on /checkout, saved so that a checkout left without pressing Pay can be
 * noticed later by the server — not by the browser, which may be gone.
 *
 * A record is never an order and never grants anything. Its life:
 *
 *   in_progress  → details saved, nothing paid for yet
 *   payment_started  the customer pressed Pay (an order was opened)
 *   paid         that order settled
 *   abandoned    the grace period passed with no payment attempt
 *   converted    the customer bought the plan some other way meanwhile
 */

export type CheckoutSession = {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  currency: string;
  amountMinor: number;
  billingName: string;
  billingEmail: string;
  billingPhone: string | null;
  billingCountry: string | null;
  status: "in_progress" | "payment_started" | "paid" | "abandoned" | "converted";
  paymentOrderId: string | null;
  createdAt: number;
  detailsSavedAt: number;
  paymentStartedAt: number | null;
  abandonedAt: number | null;
};

type Row = {
  id: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  currency: string;
  amount_minor: number;
  billing_name: string;
  billing_email: string;
  billing_phone: string | null;
  billing_country: string | null;
  status: CheckoutSession["status"];
  payment_order_id: string | null;
  created_at: number;
  details_saved_at: number;
  payment_started_at: number | null;
  abandoned_at: number | null;
};

function toSession(row: Row): CheckoutSession {
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    planName: row.plan_name,
    currency: row.currency,
    amountMinor: row.amount_minor,
    billingName: row.billing_name,
    billingEmail: row.billing_email,
    billingPhone: row.billing_phone,
    billingCountry: row.billing_country,
    status: row.status,
    paymentOrderId: row.payment_order_id,
    createdAt: row.created_at,
    detailsSavedAt: row.details_saved_at,
    paymentStartedAt: row.payment_started_at,
    abandonedAt: row.abandoned_at,
  };
}

export function findCheckoutSession(id: string): CheckoutSession | null {
  const row = one<Row>("SELECT * FROM checkout_sessions WHERE id = ?", [id]);
  return row ? toSession(row) : null;
}

/** A session id from the browser is only honoured if it is this user's. */
function ownedSession(id: unknown, userId: string): Row | null {
  if (typeof id !== "string" || !/^chk_[A-Za-z0-9_-]{16}$/.test(id)) return null;
  return one<Row>("SELECT * FROM checkout_sessions WHERE id = ? AND user_id = ?", [id, userId]);
}

/**
 * Creates or refreshes this customer's checkout record. Called only with
 * details that have passed the server's billing validation, and with the
 * amount read from the plan catalogue — never from the browser.
 */
export function saveCheckoutProgress(input: {
  checkoutId: unknown;
  userId: string;
  plan: { id: string; name: string };
  currency: string;
  amountMinor: number;
  billing: { name: string; email: string; phone: string; country: string };
  now?: number;
}): CheckoutSession {
  const now = input.now ?? Date.now();
  const existing = ownedSession(input.checkoutId, input.userId);
  // A record that already led to a payment is history; a new edit starts
  // a new record rather than rewriting what was paid for.
  if (existing && (existing.status === "in_progress" || existing.status === "abandoned")) {
    run(
      `UPDATE checkout_sessions
          SET plan_id = ?, plan_name = ?, currency = ?, amount_minor = ?, billing_name = ?, billing_email = ?,
              billing_phone = ?, billing_country = ?, status = 'in_progress', abandoned_at = NULL,
              details_saved_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        input.plan.id, input.plan.name, input.currency, input.amountMinor, input.billing.name, input.billing.email,
        input.billing.phone || null, input.billing.country || null, now, now, existing.id,
      ],
    );
    return findCheckoutSession(existing.id)!;
  }
  const id = newId("chk");
  run(
    `INSERT INTO checkout_sessions
       (id, user_id, plan_id, plan_name, currency, amount_minor, billing_name, billing_email, billing_phone,
        billing_country, status, created_at, details_saved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
    [
      id, input.userId, input.plan.id, input.plan.name, input.currency, input.amountMinor, input.billing.name,
      input.billing.email, input.billing.phone || null, input.billing.country || null, now, now, now,
    ],
  );
  return findCheckoutSession(id)!;
}

/**
 * The customer pressed Pay. From here the record is out of the
 * abandonment sweep for good — a pending payment is not an abandonment.
 * Without a session id (older clients), the newest open record for the
 * same plan is used.
 */
export function markPaymentStarted(input: { checkoutId: unknown; userId: string; planId: string; orderId: string | null; now?: number }): string | null {
  const now = input.now ?? Date.now();
  const row =
    ownedSession(input.checkoutId, input.userId) ??
    one<Row>(
      `SELECT * FROM checkout_sessions WHERE user_id = ? AND plan_id = ? AND status IN ('in_progress', 'abandoned')
        ORDER BY details_saved_at DESC LIMIT 1`,
      [input.userId, input.planId],
    );
  if (!row || row.status === "paid") return null;
  run(
    `UPDATE checkout_sessions SET status = 'payment_started', payment_order_id = COALESCE(?, payment_order_id),
            payment_started_at = ?, updated_at = ?
      WHERE id = ? AND status <> 'paid'`,
    [input.orderId, now, now, row.id],
  );
  return row.id;
}

/** The order settled: its record is paid, and other open ones for that plan are moot. */
export function markCheckoutPaid(orderId: string, now = Date.now()): void {
  const row = one<Row>("SELECT * FROM checkout_sessions WHERE payment_order_id = ?", [orderId]);
  if (row) {
    run("UPDATE checkout_sessions SET status = 'paid', updated_at = ? WHERE id = ?", [now, row.id]);
    run(
      `UPDATE checkout_sessions SET status = 'converted', updated_at = ?
        WHERE user_id = ? AND plan_id = ? AND status IN ('in_progress', 'abandoned')`,
      [now, row.user_id, row.plan_id],
    );
  }
}

export function sessionForOrder(orderId: string): CheckoutSession | null {
  const row = one<Row>("SELECT * FROM checkout_sessions WHERE payment_order_id = ?", [orderId]);
  return row ? toSession(row) : null;
}

/**
 * Claims checkouts whose grace period has passed with no payment attempt.
 * Each claim is a single guarded UPDATE, so two overlapping runs cannot
 * both claim the same record. Re-checks the payments table too: if the
 * customer opened an order or holds the plan now, the record is closed
 * as converted instead of being reported.
 */
export function claimAbandoned(now: number, graceMs: number, limit: number): CheckoutSession[] {
  const cutoff = now - graceMs;
  const candidates = many<Row>(
    `SELECT * FROM checkout_sessions WHERE status = 'in_progress' AND details_saved_at <= ?
      ORDER BY details_saved_at ASC LIMIT ?`,
    [cutoff, limit],
  );
  const claimed: CheckoutSession[] = [];
  for (const row of candidates) {
    const startedPayment = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND plan_id = ? AND created_at >= ?`,
      [row.user_id, row.plan_id, row.created_at],
    )?.n;
    const holdsPlan = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active' AND created_at >= ?`,
      [row.user_id, row.plan_id, row.created_at],
    )?.n;
    if (startedPayment || holdsPlan) {
      run(
        `UPDATE checkout_sessions SET status = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'`,
        [holdsPlan ? "converted" : "payment_started", now, row.id],
      );
      continue;
    }
    const changed = run(
      `UPDATE checkout_sessions SET status = 'abandoned', abandoned_at = ?, updated_at = ?
        WHERE id = ? AND status = 'in_progress' AND details_saved_at <= ?`,
      [now, now, row.id, cutoff],
    ).changes;
    if (changed === 1) claimed.push(toSession({ ...row, status: "abandoned", abandoned_at: now }));
  }
  return claimed;
}

/** Retention: checkout records without a payment are kept 30 days. */
export function purgeOldCheckouts(now: number): number {
  return run(
    `DELETE FROM checkout_sessions WHERE status IN ('in_progress', 'abandoned', 'converted') AND updated_at < ?`,
    [now - 30 * 24 * 60 * 60 * 1000],
  ).changes;
}

export function listCheckoutSessions(limit = 50): CheckoutSession[] {
  return many<Row>("SELECT * FROM checkout_sessions ORDER BY updated_at DESC LIMIT ?", [limit]).map(toSession);
}
