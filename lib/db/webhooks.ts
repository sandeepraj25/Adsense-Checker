import { isUniqueViolation, many, one, run } from "./index";
import { toWebhookEvent, type WebhookEvent, type WebhookEventRow, type WebhookOutcome } from "./types";

/**
 * The webhook ledger.
 *
 * Gateways retry. All of them, deliberately, until they get a 2xx — so
 * "did I already act on this event?" is not an edge case, it is the normal
 * case. Every delivery is claimed here first, by its own event id, and a
 * second copy of the same event loses the insert and is answered with a
 * cheerful 200 instead of granting a second subscription.
 */

/**
 * Claims an event id. Returns false if this id was already recorded,
 * which means some earlier delivery already did the work.
 *
 * The UNIQUE primary key is what provides the mutual exclusion; two
 * concurrent deliveries of the same event cannot both win the insert, so
 * this is safe without a transaction around the handler.
 */
export function claimWebhookEvent(input: {
  id: string;
  gateway: string;
  eventType: string | null;
  payloadHash: string;
}): boolean {
  try {
    run(
      `INSERT INTO webhook_events
         (id, gateway, event_type, payload_hash, outcome, detail, received_at)
       VALUES (?, ?, ?, ?, 'processed', NULL, ?)`,
      [
        input.id,
        input.gateway,
        input.eventType,
        input.payloadHash,
        Date.now(),
      ],
    );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Gives an event id back.
 *
 * Called when processing threw *after* the claim succeeded — a database
 * error, a gateway read that timed out. Without this the claim would make
 * the gateway's retry look like a duplicate and the payment would never be
 * fulfilled, which is a far worse failure than processing it twice (which
 * `fulfilPayment` is already proof against).
 */
export function releaseWebhookEvent(id: string): void {
  run("DELETE FROM webhook_events WHERE id = ?", [id]);
}

export function setWebhookOutcome(
  id: string,
  outcome: WebhookOutcome,
  detail?: string | null,
): void {
  run("UPDATE webhook_events SET outcome = ?, detail = ? WHERE id = ?", [
    outcome,
    detail?.slice(0, 300) ?? null,
    id,
  ]);
}

/**
 * Records a delivery we refused — a bad signature, an unparseable body, an
 * event for an order we do not have.
 *
 * Rejections are logged with a synthetic id so that a burst of them is
 * visible in the admin panel. A gateway misconfiguration otherwise looks
 * exactly like silence.
 */
export function recordWebhookRejection(input: {
  id: string;
  gateway: string;
  eventType?: string | null;
  payloadHash: string;
  outcome: Exclude<WebhookOutcome, "processed">;
  detail: string;
}): void {
  try {
    run(
      `INSERT INTO webhook_events
         (id, gateway, event_type, payload_hash, outcome, detail, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.gateway,
        input.eventType ?? null,
        input.payloadHash,
        input.outcome,
        input.detail.slice(0, 300),
        Date.now(),
      ],
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

export function wasWebhookSeen(id: string): boolean {
  return (
    one<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_events WHERE id = ?", [
      id,
    ])?.n === 1
  );
}

export function listWebhookEvents(limit = 100): WebhookEvent[] {
  return many<WebhookEventRow>(
    "SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?",
    [limit],
  ).map(toWebhookEvent);
}

export function countWebhookEvents(outcome?: WebhookOutcome): number {
  const row = outcome
    ? one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM webhook_events WHERE outcome = ?",
        [outcome],
      )
    : one<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_events");
  return row?.n ?? 0;
}
