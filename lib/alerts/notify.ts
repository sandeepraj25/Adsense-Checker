import { many, one, run } from "@/lib/db";
import { findUserById } from "@/lib/db/accounts";
import { findPaymentByOrderId } from "@/lib/db/billing";
import { emailStatus, sendEmail } from "@/lib/email";
import { APP_URL } from "@/lib/env";
import { newId } from "@/lib/ids";

import { sessionForOrder, type CheckoutSession } from "./checkout";
import { alertEmail } from "./settings";
import { renderAlert } from "./templates";

/**
 * The alert outbox.
 *
 *   enqueue  → one row per event, keyed by `dedupe_key` (UNIQUE), so the
 *              same failed order or abandoned checkout can only ever
 *              produce one alert, however often it is reported.
 *   deliver  → a guarded UPDATE claims the row (status → sending, locked
 *              for 2 minutes) before anything is sent, so two workers —
 *              the scheduled job and an immediate send — cannot both
 *              send it. A crash mid-send just lets the lock expire.
 *   outcome  → sent (with the provider's message id), retry (transient
 *              failure, bounded backoff), failed (permanent rejection or
 *              out of attempts), or skipped (no alert address set).
 *
 * Nothing is ever recorded as sent unless the provider accepted it.
 */

export type AlertType = "payment_failed" | "abandoned_checkout";
export type NotificationStatus = "pending" | "sending" | "retry" | "sent" | "failed" | "skipped";

export type AlertPayload = {
  type: AlertType;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  userId: string | null;
  planId: string;
  planName: string;
  currency: string;
  expectedAmountMinor: number;
  // payment_failed
  gateway?: string;
  orderId?: string;
  gatewayPaymentId?: string | null;
  failureReason?: string | null;
  paymentStatus?: string;
  attemptedAt?: number;
  failedAt?: number;
  previouslyAbandonedAt?: number | null;
  // abandoned_checkout
  checkoutId?: string;
  detailsSavedAt?: number;
  detectedAt?: number;
  adminUrl: string;
};

export const MAX_ATTEMPTS = 5;
/** Waits after attempt 1, 2, 3, 4: 1 min, 5 min, 30 min, 2 h, 6 h. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const LOCK_MS = 2 * 60_000;

type Row = {
  id: string;
  type: AlertType;
  dedupe_key: string;
  checkout_id: string | null;
  order_id: string | null;
  user_id: string | null;
  destination: string | null;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: number;
  locked_until: number | null;
  last_error: string | null;
  provider: string | null;
  provider_id: string | null;
  payload_json: string;
  created_at: number;
  sent_at: number | null;
  updated_at: number;
};

export type NotificationView = {
  id: string;
  type: AlertType;
  status: NotificationStatus;
  destination: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  provider: string | null;
  createdAt: number;
  sentAt: number | null;
  customer: string | null;
  planName: string | null;
  amountMinor: number | null;
  currency: string | null;
  orderId: string | null;
  checkoutId: string | null;
  userId: string | null;
  retryable: boolean;
};

function payloadOf(row: Row): Partial<AlertPayload> {
  try {
    return JSON.parse(row.payload_json) as Partial<AlertPayload>;
  } catch {
    return {};
  }
}

function toView(row: Row): NotificationView {
  const p = payloadOf(row);
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    destination: row.destination,
    attempts: row.attempts,
    nextAttemptAt: row.status === "retry" || row.status === "pending" ? row.next_attempt_at : null,
    lastError: row.last_error,
    provider: row.provider,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    customer: p.customerName ?? p.customerEmail ?? null,
    planName: p.planName ?? null,
    amountMinor: typeof p.expectedAmountMinor === "number" ? p.expectedAmountMinor : null,
    currency: p.currency ?? null,
    orderId: row.order_id,
    checkoutId: row.checkout_id,
    userId: row.user_id,
    retryable: row.status === "failed" || row.status === "retry" || row.status === "skipped",
  };
}

export function listNotifications(limit = 100): NotificationView[] {
  return many<Row>("SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?", [limit]).map(toView);
}

export function findNotification(id: string): NotificationView | null {
  const row = one<Row>("SELECT * FROM notifications WHERE id = ?", [id]);
  return row ? toView(row) : null;
}

/** Inserts the alert unless one for the same event exists. Returns the new id, or null. */
export function enqueue(input: {
  type: AlertType;
  dedupeKey: string;
  checkoutId?: string | null;
  orderId?: string | null;
  userId?: string | null;
  payload: AlertPayload;
  now?: number;
}): string | null {
  const now = input.now ?? Date.now();
  const id = newId("ntf");
  const inserted = run(
    `INSERT OR IGNORE INTO notifications
       (id, type, dedupe_key, checkout_id, order_id, user_id, status, attempts, next_attempt_at, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    [id, input.type, input.dedupeKey, input.checkoutId ?? null, input.orderId ?? null, input.userId ?? null, now, JSON.stringify(input.payload), now, now],
  ).changes;
  return inserted === 1 ? id : null;
}

/** Sends one due alert. Safe to call from anywhere, any number of times. */
export async function deliver(id: string, now = Date.now()): Promise<NotificationStatus | "not_due"> {
  const claimed = run(
    `UPDATE notifications SET status = 'sending', locked_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retry') AND next_attempt_at <= ?
        AND (locked_until IS NULL OR locked_until < ?)`,
    [now + LOCK_MS, now, id, now, now],
  ).changes;
  if (claimed !== 1) return "not_due";
  const row = one<Row>("SELECT * FROM notifications WHERE id = ?", [id])!;

  const finish = (status: NotificationStatus, fields: { error?: string | null; provider?: string | null; providerId?: string | null; destination?: string | null }) => {
    const retryAt = status === "retry" ? now + BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)] : row.next_attempt_at;
    run(
      `UPDATE notifications
          SET status = ?, locked_until = NULL, last_error = ?, provider = COALESCE(?, provider), provider_id = COALESCE(?, provider_id),
              destination = COALESCE(?, destination), next_attempt_at = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
              updated_at = ?
        WHERE id = ?`,
      [
        status, fields.error ?? null, fields.provider ?? null, fields.providerId ?? null, fields.destination ?? null,
        retryAt, status, now, now, id,
      ],
    );
    return status;
  };

  const to = alertEmail();
  if (!to) {
    // Off by the admin's choice: recorded, not pretended.
    return finish("skipped", { error: "No alert email is configured in Admin → Notifications." });
  }

  const provider = emailStatus();
  if (!provider.configured) {
    const status = row.attempts >= MAX_ATTEMPTS ? "failed" : "retry";
    return finish(status, { error: `Email delivery isn't configured: ${provider.problem}`, destination: to });
  }

  const payload = { ...(payloadOf(row) as AlertPayload) };
  const message = renderAlert(payload, to);
  let result;
  try {
    result = await sendEmail(message);
  } catch (error) {
    result = { ok: false as const, provider: provider.provider, reason: error instanceof Error ? error.name : "send error", transient: true };
  }

  if (result.ok) {
    return finish("sent", { provider: result.provider, providerId: result.id, destination: to });
  }
  const transient = result.transient === true;
  const status = transient && row.attempts < MAX_ATTEMPTS ? "retry" : "failed";
  return finish(status, {
    provider: result.provider,
    destination: to,
    error: `${transient ? "Temporary" : "Rejected"}: ${result.reason}`.slice(0, 300),
  });
}

/** Alerts that are due, oldest first, bounded. Each is claimed before sending. */
export async function processDue(now = Date.now(), limit = 25): Promise<Record<string, number>> {
  const due = many<{ id: string }>(
    `SELECT id FROM notifications
      WHERE (status IN ('pending', 'retry') AND next_attempt_at <= ?)
         OR (status = 'sending' AND locked_until < ?)
      ORDER BY next_attempt_at ASC LIMIT ?`,
    [now, now, limit],
  );
  const tally: Record<string, number> = {};
  for (const { id } of due) {
    // A row left in 'sending' by a crashed process goes back to retry first.
    run(
      `UPDATE notifications SET status = 'retry', locked_until = NULL WHERE id = ? AND status = 'sending' AND locked_until < ?`,
      [id, now],
    );
    const outcome = await deliver(id, now);
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  return tally;
}

/** An admin asks to try again now. Allowed for failed, retrying or skipped alerts. */
export function requeue(id: string, now = Date.now()): boolean {
  return (
    run(
      `UPDATE notifications
          SET status = 'retry', next_attempt_at = ?, locked_until = NULL,
              attempts = CASE WHEN attempts >= ? THEN ? ELSE attempts END, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'retry', 'skipped')`,
      [now, MAX_ATTEMPTS, MAX_ATTEMPTS - 1, now, id],
    ).changes === 1
  );
}

/** Hand the work to the outbox now, but never make the caller wait on email. */
function kick(id: string | null): void {
  if (!id) return;
  void deliver(id).catch((error) => console.error("[alerts] delivery error", error instanceof Error ? error.name : error));
}

/* ── the two events ─────────────────────────────────────────────── */

/**
 * The gateway — not the browser — confirmed this order failed. Called
 * after the payment row was moved to `failed`, never for pending,
 * cancelled or timed-out attempts.
 */
export function notifyPaymentFailed(input: { orderId: string; reason: string; gatewayPaymentId?: string | null; now?: number }): string | null {
  const now = input.now ?? Date.now();
  const payment = findPaymentByOrderId(input.orderId);
  if (!payment || payment.status !== "failed") return null;
  const user = findUserById(payment.userId);
  const session = sessionForOrder(input.orderId);
  const plan = one<{ name: string }>("SELECT name FROM plans WHERE id = ?", [payment.planId]);

  const id = enqueue({
    type: "payment_failed",
    dedupeKey: `payment_failed:${input.orderId}`,
    checkoutId: session?.id ?? null,
    orderId: input.orderId,
    userId: payment.userId,
    now,
    payload: {
      type: "payment_failed",
      customerName: payment.billingName ?? user?.name ?? null,
      customerEmail: payment.billingEmail ?? user?.email ?? null,
      customerPhone: payment.billingPhone ?? null,
      userId: payment.userId,
      planId: payment.planId,
      planName: plan?.name ?? payment.planId,
      currency: payment.currency,
      expectedAmountMinor: payment.amountPaise,
      gateway: payment.gateway,
      orderId: input.orderId,
      gatewayPaymentId: input.gatewayPaymentId ?? payment.paymentId ?? null,
      failureReason: (input.reason || payment.failureReason || "").slice(0, 300) || null,
      paymentStatus: "failed",
      attemptedAt: payment.createdAt,
      failedAt: now,
      previouslyAbandonedAt: session?.abandonedAt ?? null,
      adminUrl: `${APP_URL}/admin/users/${payment.userId}`,
    },
  });
  kick(id);
  return id;
}

export function notifyAbandoned(session: CheckoutSession, now = Date.now()): string | null {
  const id = enqueue({
    type: "abandoned_checkout",
    dedupeKey: `abandoned_checkout:${session.id}`,
    checkoutId: session.id,
    userId: session.userId,
    now,
    payload: {
      type: "abandoned_checkout",
      customerName: session.billingName,
      customerEmail: session.billingEmail,
      customerPhone: session.billingPhone,
      userId: session.userId,
      planId: session.planId,
      planName: session.planName,
      currency: session.currency,
      expectedAmountMinor: session.amountMinor,
      checkoutId: session.id,
      detailsSavedAt: session.detailsSavedAt,
      detectedAt: now,
      adminUrl: `${APP_URL}/admin/settings/notifications#${session.id}`,
    },
  });
  return id;
}

/** Retention: alert bodies (which name customers) are cleared after 90 days. */
export function scrubOldPayloads(now: number): number {
  return run(
    "UPDATE notifications SET payload_json = '{}' WHERE created_at < ? AND payload_json <> '{}' AND status IN ('sent', 'failed', 'skipped')",
    [now - 90 * 24 * 60 * 60 * 1000],
  ).changes;
}

export function notificationCounts(): Record<NotificationStatus, number> {
  const out = { pending: 0, sending: 0, retry: 0, sent: 0, failed: 0, skipped: 0 } as Record<NotificationStatus, number>;
  for (const row of many<{ status: NotificationStatus; n: number }>("SELECT status, COUNT(*) AS n FROM notifications GROUP BY status")) {
    out[row.status] = row.n;
  }
  return out;
}
