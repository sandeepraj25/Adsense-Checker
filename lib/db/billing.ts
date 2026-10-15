import { isUniqueViolation, many, one, run, tx } from "./index";
import {
  toInvoice,
  toPayment,
  toSubscription,
  type GatewayEnvironment,
  type GatewayId,
  type Invoice,
  type InvoiceRow,
  type Payment,
  type PaymentMode,
  type PaymentRow,
  type Subscription,
  type SubscriptionPaymentStatus,
  type SubscriptionRow,
} from "./types";
import { newId } from "@/lib/ids";
import { BILLING_PERIOD_DAYS, type Plan, type PlanId } from "@/lib/plans";
import { addCalendarMonths, CYCLE_MONTHS, type BillingCycle } from "@/lib/billing/cycle";

const DAY_MS = 86_400_000;

/* ── subscriptions ──────────────────────────────────────────────── */

/**
 * Flips any active subscription whose window has closed to `expired`.
 * Cheap, idempotent, and called before every read so the status shown
 * in the UI is never stale.
 */
export function expireStaleSubscriptions(now = Date.now()): number {
  return run(
    "UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at <= ?",
    [now, now],
  ).changes;
}

/**
 * Starts a new monthly billing cycle for any subscription whose cycle has
 * elapsed, resetting the scan allowance.
 *
 * This is what makes 100 and 300 monthly numbers rather than a lifetime
 * grant. It runs on read instead of on a timer: there is no scheduler in
 * a Next.js app by default, and a cron job that has not been installed is
 * indistinguishable from a bug where nobody's quota ever refills.
 *
 * The new allowance comes from the plan's *current* configuration, so an
 * admin's limit change lands at renewal — the point at which the terms
 * the customer agreed to are up for renegotiation anyway.
 */
export function rollBillingCycles(now = Date.now()): number {
  // Subscriptions sold before calendar billing (schema v14) keep the
  // 30-day cycle they were sold with.
  const legacy = run(
    `UPDATE subscriptions
        SET scans_used  = 0,
            cycle_index = cycle_index + 1,
            cycle_start = cycle_end,
            cycle_end   = cycle_end + ? ,
            cycle_reset_at = ?,
            scan_limit  = COALESCE(
              (SELECT p.scan_limit FROM plans p WHERE p.id = subscriptions.plan_id),
              scan_limit
            ),
            site_limit  = COALESCE(
              (SELECT p.site_limit FROM plans p WHERE p.id = subscriptions.plan_id),
              site_limit
            ),
            page_limit  = COALESCE(
              (SELECT p.pages_per_scan FROM plans p WHERE p.id = subscriptions.plan_id),
              page_limit
            ),
            updated_at  = ?
      WHERE status = 'active'
        AND calendar_billing = 0
        AND expires_at > ?
        AND cycle_end > 0
        AND cycle_end <= ?`,
    [BILLING_PERIOD_DAYS * DAY_MS, now, now, now, now],
  ).changes;
  return legacy + rollCalendarCycles(now);
}

/**
 * Monthly allowance resets for calendar-billed subscriptions — including
 * yearly ones, whose scans and page limits still reset every month. Month
 * n ends at start + n calendar months (never chained from the previous
 * end, so the 31st does not drift to the 28th) and never after the
 * subscription itself ends. A gap of several months is caught up in one
 * step to the month that contains `now`.
 */
function rollCalendarCycles(now: number): number {
  const due = many<{ id: string; starts_at: number; expires_at: number; cycle_index: number }>(
    `SELECT id, starts_at, expires_at, cycle_index FROM subscriptions
      WHERE status = 'active' AND calendar_billing = 1 AND expires_at > ? AND cycle_end > 0 AND cycle_end <= ?`,
    [now, now],
  );
  let rolled = 0;
  for (const row of due) {
    // cycle_index n is month n, ending at start + n months; it has ended,
    // so move to n + 1 — and further if several months passed unread.
    let index = row.cycle_index + 1;
    let end = addCalendarMonths(row.starts_at, index);
    while (end <= now && end < row.expires_at) {
      index += 1;
      end = addCalendarMonths(row.starts_at, index);
    }
    const start = addCalendarMonths(row.starts_at, index - 1);
    rolled += run(
      `UPDATE subscriptions
          SET scans_used = 0, cycle_index = ?, cycle_start = ?, cycle_end = ?, cycle_reset_at = ?,
              scan_limit = COALESCE((SELECT p.scan_limit FROM plans p WHERE p.id = subscriptions.plan_id), scan_limit),
              site_limit = COALESCE((SELECT p.site_limit FROM plans p WHERE p.id = subscriptions.plan_id), site_limit),
              page_limit = COALESCE((SELECT p.pages_per_scan FROM plans p WHERE p.id = subscriptions.plan_id), page_limit),
              updated_at = ?
        WHERE id = ? AND cycle_index = ?`,
      [index, start, Math.min(end, row.expires_at), now, now, row.id, row.cycle_index],
    ).changes;
  }
  return rolled;
}

/**
 * Takes features away from the *current* subscriptions on a plan.
 *
 * Only ever called when an administrator explicitly asks for it (Admin →
 * Plans, "also remove from current subscribers"). By default a feature
 * switched off on a plan stays with people who already paid for this
 * period; this is the deliberate, logged exception. Returns how many
 * subscriptions changed.
 */
export function revokeFeaturesFromActive(planId: PlanId, features: readonly string[], now = Date.now()): number {
  if (features.length === 0) return 0;
  const remove = new Set(features);
  return tx(() => {
    const rows = many<{ id: string; features_json: string }>(
      "SELECT id, features_json FROM subscriptions WHERE plan_id = ? AND status = 'active' AND expires_at > ?",
      [planId, now],
    );
    let changed = 0;
    for (const row of rows) {
      let list: unknown;
      try {
        list = JSON.parse(row.features_json);
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      const kept = list.filter((key) => !(typeof key === "string" && remove.has(key)));
      if (kept.length === list.length) continue;
      run("UPDATE subscriptions SET features_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(kept), now, row.id]);
      changed += 1;
    }
    return changed;
  });
}

/** Expire what is over, then refill what has rolled. Order matters. */
export function settleBilling(now = Date.now()): void {
  expireStaleSubscriptions(now);
  rollBillingCycles(now);
}

export function createSubscription(input: {
  userId: string;
  plan: Plan;
  paymentStatus: SubscriptionPaymentStatus;
  /** Minor units of `currency`. Defaults to the plan's INR price. */
  amountPaise?: number;
  /**
   * The currency that amount is in — from the payment row for a purchase,
   * so a dollar subscription is recorded in dollars. Defaults to INR.
   */
  currency?: string;
  paymentId?: string | null;
  orderId?: string | null;
  gateway?: GatewayId | null;
  /** Billing periods bought up front. One, unless an admin extends it. */
  months?: number;
  /** One month per period, or twelve. Monthly unless a yearly price was paid. */
  billingCycle?: BillingCycle;
  now?: number;
}): Subscription {
  const now = input.now ?? Date.now();
  const periods = Math.max(1, Math.floor(input.months ?? 1));
  const cycle: BillingCycle = input.billingCycle ?? "monthly";
  // Calendar months from the purchase (lib/billing/cycle.ts): one for a
  // monthly period, twelve for a yearly one. The scan allowance resets
  // every calendar month either way.
  const expiresAt = addCalendarMonths(now, CYCLE_MONTHS[cycle] * periods);
  const firstCycleEnd = Math.min(addCalendarMonths(now, 1), expiresAt);
  const row: SubscriptionRow = {
    id: newId("sub"),
    user_id: input.userId,
    plan_id: input.plan.id,
    plan_name: input.plan.name,
    // Snapshotted, all of it. Re-pricing a plan next week must not change
    // what this person agreed to pay or what they were promised.
    amount_paise: input.amountPaise ?? input.plan.amountPaise,
    currency: input.currency ?? input.plan.currency,
    scan_limit: input.plan.scanLimit,
    scans_used: 0,
    site_limit: input.plan.siteLimit,
    validity_days: Math.round((expiresAt - now) / DAY_MS),
    purchased_at: now,
    starts_at: now,
    expires_at: expiresAt,
    status: "active",
    payment_status: input.paymentStatus,
    payment_id: input.paymentId ?? null,
    order_id: input.orderId ?? null,
    invoice_id: null,
    created_at: now,
    updated_at: now,
    cycle_start: now,
    cycle_end: firstCycleEnd,
    cycle_index: 1,
    cycle_reset_at: null,
    features_json: JSON.stringify(input.plan.features),
    gateway: input.gateway ?? null,
    admin_note: null,
    billing_cycle: cycle,
    calendar_billing: 1,
    page_limit: input.plan.pagesPerScan,
    next_billing_cycle: null,
    next_cycle_set_at: null,
  };

  run(
    `INSERT INTO subscriptions
       (id, user_id, plan_id, plan_name, amount_paise, currency, scan_limit,
        scans_used, site_limit, validity_days, purchased_at, starts_at,
        expires_at, status, payment_status, payment_id, order_id, invoice_id,
        created_at, updated_at, cycle_start, cycle_end, cycle_index,
        cycle_reset_at, features_json, gateway, admin_note, billing_cycle, calendar_billing, page_limit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.user_id,
      row.plan_id,
      row.plan_name,
      row.amount_paise,
      row.currency,
      row.scan_limit,
      row.scans_used,
      row.site_limit,
      row.validity_days,
      row.purchased_at,
      row.starts_at,
      row.expires_at,
      row.status,
      row.payment_status,
      row.payment_id,
      row.order_id,
      row.invoice_id,
      row.created_at,
      row.updated_at,
      row.cycle_start,
      row.cycle_end,
      row.cycle_index,
      row.cycle_reset_at,
      row.features_json,
      row.gateway,
      row.admin_note,
      cycle,
      1,
      input.plan.pagesPerScan,
    ],
  );

  // Only one subscription may be active at a time: buying an upgrade
  // supersedes whatever was running.
  run(
    `UPDATE subscriptions SET status = 'cancelled', updated_at = ?
      WHERE user_id = ? AND id != ? AND status = 'active'`,
    [now, input.userId, row.id],
  );

  return toSubscription(row, now);
}

export function getActiveSubscription(
  userId: string,
  now = Date.now(),
): Subscription | null {
  settleBilling(now);
  const row = one<SubscriptionRow>(
    `SELECT * FROM subscriptions
      WHERE user_id = ? AND status = 'active' AND expires_at > ?
      ORDER BY purchased_at DESC LIMIT 1`,
    [userId, now],
  );
  return row ? toSubscription(row, now) : null;
}

/** Latest subscription regardless of state — for "your plan expired" copy. */
export function getLatestSubscription(userId: string): Subscription | null {
  const row = one<SubscriptionRow>(
    "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY purchased_at DESC LIMIT 1",
    [userId],
  );
  return row ? toSubscription(row) : null;
}

export function listSubscriptions(userId: string): Subscription[] {
  return many<SubscriptionRow>(
    "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY purchased_at DESC",
    [userId],
  ).map((row) => toSubscription(row));
}

export function findSubscription(id: string): Subscription | null {
  const row = one<SubscriptionRow>("SELECT * FROM subscriptions WHERE id = ?", [
    id,
  ]);
  return row ? toSubscription(row) : null;
}

/**
 * Atomically claims one scan from this month's allowance.
 *
 * The guard lives in the WHERE clause, so two audits started at the same
 * moment cannot both consume the last remaining scan — and an attacker
 * calling the API directly in a loop cannot outrun it either, because the
 * limit is enforced by the database rather than by a check-then-act in
 * application code. Returns false if there was nothing left to claim.
 */
export function consumeScan(subscriptionId: string, now = Date.now()): boolean {
  const result = run(
    `UPDATE subscriptions
        SET scans_used = scans_used + 1, updated_at = ?
      WHERE id = ?
        AND status = 'active'
        AND expires_at > ?
        AND scans_used < scan_limit`,
    [now, subscriptionId, now],
  );
  return result.changes === 1;
}

/** Give a scan back when an audit fails through no fault of the user. */
export function refundScan(subscriptionId: string): void {
  run(
    `UPDATE subscriptions
        SET scans_used = MAX(0, scans_used - 1), updated_at = ?
      WHERE id = ?`,
    [Date.now(), subscriptionId],
  );
}

/* ── administrative changes to a live subscription ──────────────── */

/**
 * Moves an account onto a different plan without a payment.
 *
 * Used by the admin panel for comps, refunds-in-kind and support fixes.
 * A fresh subscription row is created rather than the current one edited,
 * so the billing history keeps showing what was actually sold and when
 * the change happened; `admin_note` records who asked for it.
 *
 * The scan counter deliberately does *not* carry over. An upgrade is a new
 * allowance, and a downgrade with 90 scans already spent would otherwise
 * leave someone at −10.
 */
export function assignPlan(input: {
  userId: string;
  plan: Plan;
  note: string;
  months?: number;
  now?: number;
}): Subscription {
  const subscription = createSubscription({
    userId: input.userId,
    plan: input.plan,
    // No money changed hands, and saying otherwise would put a phantom
    // ₹999 into the revenue figures on the admin dashboard.
    paymentStatus: input.plan.amountPaise === 0 ? "free" : "paid",
    amountPaise: 0,
    months: input.months,
    now: input.now,
  });
  setSubscriptionNote(subscription.id, input.note);
  return { ...subscription, adminNote: input.note.slice(0, 500) };
}

export function setSubscriptionExpiry(id: string, expiresAt: number): boolean {
  const now = Date.now();
  return tx(() => {
    const changed = run(
      `UPDATE subscriptions
          SET expires_at = ?,
              status = CASE WHEN ? > ? THEN 'active' ELSE 'expired' END,
              updated_at = ?
        WHERE id = ?`,
      [expiresAt, expiresAt, now, now, id],
    ).changes;
    // An extension past the current cycle end would otherwise leave the
    // monthly reset in the past, which rollBillingCycles would then apply
    // repeatedly on every read.
    run(
      `UPDATE subscriptions
          SET cycle_end = MIN(cycle_end, expires_at)
        WHERE id = ? AND cycle_end > expires_at`,
      [id],
    );
    return changed === 1;
  });
}

/** Admin override of one account's monthly allowance. */
export function setSubscriptionLimits(
  id: string,
  limits: { scanLimit?: number; siteLimit?: number; pageLimit?: number },
): boolean {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (limits.scanLimit !== undefined) {
    sets.push("scan_limit = ?");
    params.push(Math.max(1, Math.floor(limits.scanLimit)));
  }
  if (limits.siteLimit !== undefined) {
    sets.push("site_limit = ?");
    params.push(Math.max(1, Math.floor(limits.siteLimit)));
  }
  if (limits.pageLimit !== undefined) {
    sets.push("page_limit = ?");
    params.push(Math.max(1, Math.min(500, Math.floor(limits.pageLimit))));
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = ?");
  params.push(Date.now(), id);
  // Safe interpolation: every fragment in `sets` is a literal above.
  return run(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`, params)
    .changes === 1;
}

/** Clears the month's usage. For support cases and for the test suite. */
export function resetSubscriptionUsage(id: string): boolean {
  return (
    run(
      `UPDATE subscriptions
          SET scans_used = 0, cycle_reset_at = ?, updated_at = ?
        WHERE id = ?`,
      [Date.now(), Date.now(), id],
    ).changes === 1
  );
}

export function setSubscriptionStatus(
  id: string,
  status: "active" | "expired" | "cancelled",
): boolean {
  return (
    run("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?", [
      status,
      Date.now(),
      id,
    ]).changes === 1
  );
}

export function setSubscriptionNote(id: string, note: string | null): void {
  run("UPDATE subscriptions SET admin_note = ?, updated_at = ? WHERE id = ?", [
    note?.slice(0, 500) ?? null,
    Date.now(),
    id,
  ]);
}

export function attachInvoiceToSubscription(
  subscriptionId: string,
  invoiceId: string,
): void {
  run("UPDATE subscriptions SET invoice_id = ?, updated_at = ? WHERE id = ?", [
    invoiceId,
    Date.now(),
    subscriptionId,
  ]);
}

/**
 * Schedules (or clears) the billing cycle a customer wants at their next
 * renewal. Nothing is charged and the current period is not touched; the
 * renewal checkout uses it as its default. Only for this account's own
 * active subscription.
 */
export function setNextBillingCycle(input: { subscriptionId: string; userId: string; cycle: BillingCycle | null; now?: number }): boolean {
  const now = input.now ?? Date.now();
  return (
    run(
      `UPDATE subscriptions SET next_billing_cycle = ?, next_cycle_set_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'active' AND expires_at > ?`,
      [input.cycle, input.cycle ? now : null, now, input.subscriptionId, input.userId, now],
    ).changes === 1
  );
}

export function cancelSubscription(id: string): void {
  run(
    "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE id = ?",
    [Date.now(), id],
  );
}

/* ── payments ───────────────────────────────────────────────────── */

export function createPayment(input: {
  userId: string;
  planId: PlanId;
  amountPaise: number;
  currency: string;
  orderId: string;
  gateway: GatewayId;
  environment: GatewayEnvironment;
  mode: PaymentMode;
  receipt: string;
  /** Collected at checkout; null for orders opened before v4. */
  billing?: {
    name: string;
    email: string;
    phone: string;
    country: string;
  } | null;
  /** One per purchase attempt — see schema V4. */
  idempotencyKey?: string | null;
  /** What the browser was handed. Never contains a secret. */
  handoff?: unknown;
  /** The cycle this order pays for. */
  billingCycle?: BillingCycle;
}): Payment {
  const now = Date.now();
  const row: PaymentRow = {
    id: newId("pay"),
    user_id: input.userId,
    subscription_id: null,
    plan_id: input.planId,
    amount_paise: input.amountPaise,
    currency: input.currency,
    status: "created",
    mode: input.mode,
    gateway_order_id: input.orderId,
    gateway_payment_id: null,
    method: null,
    failure_reason: null,
    receipt: input.receipt,
    created_at: now,
    updated_at: now,
    verified_at: null,
    gateway: input.gateway,
    environment: input.environment,
    raw_status: null,
    billing_name: input.billing?.name ?? null,
    billing_email: input.billing?.email ?? null,
    billing_phone: input.billing?.phone ?? null,
    billing_country: input.billing?.country ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    handoff_json: input.handoff === undefined ? null : JSON.stringify(input.handoff),
    billing_cycle: input.billingCycle ?? "monthly",
  };

  try {
  run(
    `INSERT INTO payments
       (id, user_id, subscription_id, plan_id, amount_paise, currency, status,
        mode, gateway_order_id, gateway_payment_id, method, failure_reason,
        receipt, created_at, updated_at, verified_at, gateway, environment,
        raw_status, billing_name, billing_email, billing_phone, billing_country,
        idempotency_key, handoff_json, billing_cycle)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.user_id,
      row.subscription_id,
      row.plan_id,
      row.amount_paise,
      row.currency,
      row.status,
      row.mode,
      row.gateway_order_id,
      row.gateway_payment_id,
      row.method,
      row.failure_reason,
      row.receipt,
      row.created_at,
      row.updated_at,
      row.verified_at,
      row.gateway,
      row.environment,
      row.raw_status,
      row.billing_name ?? null,
      row.billing_email ?? null,
      row.billing_phone ?? null,
      row.billing_country ?? null,
      row.idempotency_key ?? null,
      row.handoff_json ?? null,
      row.billing_cycle ?? "monthly",
    ],
  );
  } catch (error) {
    // Two requests with the same purchase-attempt key raced; the other
    // one's order stands and this one is answered with it.
    if (input.idempotencyKey && isUniqueViolation(error)) {
      throw new DuplicateCheckoutAttempt(input.idempotencyKey);
    }
    throw error;
  }

  return toPayment(row);
}

export class DuplicateCheckoutAttempt extends Error {
  constructor(key: string) {
    super(`checkout attempt ${key} already has an order`);
    this.name = "DuplicateCheckoutAttempt";
  }
}

/** The order an earlier submission of the same checkout attempt opened. */
export function findPaymentByAttempt(
  userId: string,
  idempotencyKey: string,
): { payment: Payment; handoff: unknown } | null {
  const row = one<PaymentRow>(
    "SELECT * FROM payments WHERE user_id = ? AND idempotency_key = ?",
    [userId, idempotencyKey],
  );
  if (!row) return null;
  let handoff: unknown = null;
  try {
    handoff = row.handoff_json ? JSON.parse(row.handoff_json) : null;
  } catch {
    handoff = null;
  }
  return { payment: toPayment(row), handoff };
}

/**
 * The details this account entered at its most recent checkout, used to
 * prefill the next one. Only a person's own past entries — never their
 * display name, which is not necessarily their legal name.
 */
export function latestBillingDetails(userId: string): {
  name: string;
  email: string;
  phone: string;
  country: string;
} | null {
  const row = one<PaymentRow>(
    `SELECT * FROM payments
      WHERE user_id = ? AND billing_name IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [userId],
  );
  if (!row?.billing_name || !row.billing_email || !row.billing_phone || !row.billing_country) {
    return null;
  }
  return {
    name: row.billing_name,
    email: row.billing_email,
    phone: row.billing_phone,
    country: row.billing_country,
  };
}

export function findPaymentByOrderId(orderId: string): Payment | null {
  const row = one<PaymentRow>(
    "SELECT * FROM payments WHERE gateway_order_id = ?",
    [orderId],
  );
  return row ? toPayment(row) : null;
}

export function findPayment(id: string): Payment | null {
  const row = one<PaymentRow>("SELECT * FROM payments WHERE id = ?", [id]);
  return row ? toPayment(row) : null;
}

/**
 * Marks a created payment as paid. The `status = 'created'` guard makes
 * this idempotent: a duplicate callback, or a webhook racing the
 * browser redirect, changes 0 rows and the caller treats it as
 * "already settled" rather than granting a second subscription.
 */
export function markPaymentPaid(input: {
  orderId: string;
  gatewayPaymentId: string;
  subscriptionId: string;
  method?: string | null;
  rawStatus?: string | null;
}): boolean {
  const now = Date.now();
  const result = run(
    `UPDATE payments
        SET status = 'paid',
            gateway_payment_id = ?,
            subscription_id = ?,
            method = ?,
            raw_status = ?,
            verified_at = ?,
            updated_at = ?
      WHERE gateway_order_id = ? AND status = 'created'`,
    [
      input.gatewayPaymentId,
      input.subscriptionId,
      input.method ?? null,
      input.rawStatus ?? null,
      now,
      now,
      input.orderId,
    ],
  );
  return result.changes === 1;
}

export function markPaymentFailed(
  orderId: string,
  reason: string,
  status: "failed" | "cancelled" = "failed",
): boolean {
  const now = Date.now();
  // True only for the call that actually moved the row — so whatever
  // follows (an alert) happens once, not once per redelivery.
  return (
    run(
      `UPDATE payments
          SET status = ?, failure_reason = ?, updated_at = ?
        WHERE gateway_order_id = ? AND status = 'created'`,
      [status, reason.slice(0, 300), now, orderId],
    ).changes === 1
  );
}

export function listPayments(userId: string): Payment[] {
  return many<PaymentRow>(
    "SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC",
    [userId],
  ).map(toPayment);
}

/* ── invoices ───────────────────────────────────────────────────── */

function nextInvoiceNumber(now: number): string {
  const date = new Date(now);
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?",
    [`INV-${stamp}-%`],
  );
  const sequence = String((row?.n ?? 0) + 1).padStart(4, "0");
  return `INV-${stamp}-${sequence}`;
}

export function createInvoice(input: {
  userId: string;
  paymentId: string;
  subscriptionId: string;
  billingName: string;
  billingEmail: string;
  planName: string;
  amountPaise: number;
  currency: string;
  periodStart: number;
  periodEnd: number;
  billingCycle?: BillingCycle;
}): Invoice {
  const now = Date.now();
  const row: InvoiceRow = {
    id: newId("inv"),
    number: nextInvoiceNumber(now),
    user_id: input.userId,
    payment_id: input.paymentId,
    subscription_id: input.subscriptionId,
    billing_name: input.billingName,
    billing_email: input.billingEmail,
    plan_name: input.planName,
    amount_paise: input.amountPaise,
    currency: input.currency,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    issued_at: now,
    billing_cycle: input.billingCycle ?? "monthly",
  };

  run(
    `INSERT INTO invoices
       (id, number, user_id, payment_id, subscription_id, billing_name,
        billing_email, plan_name, amount_paise, currency, period_start,
        period_end, issued_at, billing_cycle)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.number,
      row.user_id,
      row.payment_id,
      row.subscription_id,
      row.billing_name,
      row.billing_email,
      row.plan_name,
      row.amount_paise,
      row.currency,
      row.period_start,
      row.period_end,
      row.issued_at,
      row.billing_cycle ?? "monthly",
    ],
  );

  return toInvoice(row);
}

export function findInvoice(id: string): Invoice | null {
  const row = one<InvoiceRow>("SELECT * FROM invoices WHERE id = ?", [id]);
  return row ? toInvoice(row) : null;
}

export function findInvoiceByPayment(paymentId: string): Invoice | null {
  const row = one<InvoiceRow>("SELECT * FROM invoices WHERE payment_id = ?", [
    paymentId,
  ]);
  return row ? toInvoice(row) : null;
}

export function listInvoices(userId: string): Invoice[] {
  return many<InvoiceRow>(
    "SELECT * FROM invoices WHERE user_id = ? ORDER BY issued_at DESC",
    [userId],
  ).map(toInvoice);
}
