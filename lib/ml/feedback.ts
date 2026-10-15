import { many, one, run, tx } from "@/lib/db";
import { newId } from "@/lib/ids";

import { FEEDBACK_DELAY_DAYS, isRejectionReason, MAX_ASKS, MIN_ACCOUNT_AGE_DAYS } from "./constants";

/**
 * "Did AdSense approve your site?" — asking, and deciding what an answer
 * is worth.
 *
 * Asking. Each completed live scan opens (or refreshes) one prompt per
 * account and site, due 14 days after the scan. A newer scan of the same
 * site moves the prompt to the newer scan — the numbers closest to the
 * application — without pushing the date back. Nobody is asked about a
 * site they already reported approved; after a rejection, a later scan
 * opens a fresh prompt, because a re-application is a new observation.
 * "Not applied yet" asks again in 14 days, three times at most.
 *
 * Deciding. Every submission is stored in ml_feedback with what happened
 * to it and why:
 *
 *   accepted    the label is set on the scan it was asked about
 *   deferred    the account is under 3 days old; kept, and accepted
 *               automatically once the account is old enough
 *   recorded    "not applied yet" — no label, prompt rescheduled
 *   duplicate   the same answer again; nothing changes
 *   superseded  an accepted answer later corrected
 *   refused     not usable, with the reason (no scan data, a second
 *               correction, a correction after 7 days, …)
 *
 * One accepted outcome per account, site and application (scan): the
 * first answer counts, and it can be corrected once, within 7 days.
 */

const DAY = 86_400_000;
const CORRECTION_WINDOW_MS = 7 * DAY;

export type FeedbackOutcome = "approved" | "rejected" | "not_applied";

export type FeedbackRequest = {
  id: string;
  userId: string;
  domain: string;
  reportId: string;
  reportRef: string | null;
  scannedAt: number | null;
  state: "open" | "answered" | "closed";
  dueAt: number;
  askCount: number;
};

type RequestRow = {
  id: string;
  user_id: string;
  domain: string;
  report_id: string;
  state: "open" | "answered" | "closed";
  due_at: number;
  ask_count: number;
  ref?: string | null;
  finished_at?: number | null;
};

function toRequest(row: RequestRow): FeedbackRequest {
  return {
    id: row.id,
    userId: row.user_id,
    domain: row.domain,
    reportId: row.report_id,
    reportRef: row.ref ?? null,
    scannedAt: row.finished_at ?? null,
    state: row.state,
    dueAt: row.due_at,
    askCount: row.ask_count,
  };
}

/** Called once per completed live scan, after its features are stored. */
export function ensureFeedbackRequest(input: { userId: string; domain: string; reportId: string; scannedAt: number; now?: number }): "created" | "moved" | "not_needed" {
  const now = input.now ?? Date.now();
  return tx(() => {
    const open = one<{ id: string }>("SELECT id FROM feedback_requests WHERE user_id = ? AND domain = ? AND state = 'open'", [input.userId, input.domain]);
    if (open) {
      run("UPDATE feedback_requests SET report_id = ?, updated_at = ? WHERE id = ?", [input.reportId, now, open.id]);
      return "moved";
    }
    const latest = one<{ label: string; labeled_at: number }>(
      `SELECT label, labeled_at FROM scan_features
        WHERE user_id = ? AND domain = ? AND label IS NOT NULL AND label_status IN ('accepted', 'deferred')
        ORDER BY labeled_at DESC LIMIT 1`,
      [input.userId, input.domain],
    );
    if (latest?.label === "approved") return "not_needed";
    if (latest && latest.labeled_at >= input.scannedAt) return "not_needed";
    const closed = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM feedback_requests WHERE user_id = ? AND domain = ? AND state = 'closed' AND updated_at > ?",
      [input.userId, input.domain, latest?.labeled_at ?? 0],
    );
    if ((closed?.n ?? 0) > 0) return "not_needed"; // asked the maximum number of times already
    run(
      `INSERT INTO feedback_requests (id, user_id, domain, report_id, state, due_at, ask_count, email_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, 1, 'waiting', ?, ?)`,
      [newId("fbr"), input.userId, input.domain, input.reportId, input.scannedAt + FEEDBACK_DELAY_DAYS * DAY, now, now],
    );
    return "created";
  });
}

/** The prompts due for this account now, oldest first. */
export function dueFeedbackRequests(userId: string, now = Date.now(), limit = 3): FeedbackRequest[] {
  return many<RequestRow>(
    `SELECT f.*, r.ref, r.finished_at FROM feedback_requests f LEFT JOIN reports r ON r.id = f.report_id
      WHERE f.user_id = ? AND f.state = 'open' AND f.due_at <= ?
      ORDER BY f.due_at ASC LIMIT ?`,
    [userId, now, limit],
  ).map(toRequest);
}

export type SubmitResult =
  | { ok: true; status: "accepted" | "deferred" | "recorded" | "duplicate"; message: string }
  | { ok: false; code: "NOT_FOUND" | "VALIDATION_ERROR" | "CONFLICT"; message: string };

function record(input: {
  userId: string;
  domain: string;
  requestId: string | null;
  scanFeaturesId: string | null;
  outcome: FeedbackOutcome;
  reason: string | null;
  status: string;
  statusReason: string;
  now: number;
}): void {
  run(
    `INSERT INTO ml_feedback (id, user_id, domain, request_id, scan_features_id, outcome, rejection_reason, status, status_reason, source, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dashboard', ?, ?)`,
    [newId("fbk"), input.userId, input.domain, input.requestId, input.scanFeaturesId, input.outcome, input.reason, input.status, input.statusReason, input.now, input.now],
  );
}

/**
 * Applies one answer. Validation of the account (signed in, not blocked)
 * and rate limiting happen in the route; everything about the answer
 * itself happens here, inside one transaction.
 */
export function submitFeedback(input: {
  userId: string;
  accountCreatedAt: number;
  requestId: string;
  outcome: unknown;
  reason?: unknown;
  now?: number;
}): SubmitResult {
  const now = input.now ?? Date.now();
  if (input.outcome !== "approved" && input.outcome !== "rejected" && input.outcome !== "not_applied") {
    return { ok: false, code: "VALIDATION_ERROR", message: "Choose Approved, Rejected or Not applied yet." };
  }
  const outcome: FeedbackOutcome = input.outcome;
  let reason: string | null = null;
  if (outcome === "rejected" && input.reason !== undefined && input.reason !== null && input.reason !== "") {
    if (!isRejectionReason(input.reason)) return { ok: false, code: "VALIDATION_ERROR", message: "Choose a reason from the list, or leave it empty." };
    reason = input.reason;
  }

  return tx((): SubmitResult => {
    // Ownership is part of the query.
    const request = one<RequestRow>("SELECT * FROM feedback_requests WHERE id = ? AND user_id = ?", [input.requestId, input.userId]);
    if (!request) return { ok: false, code: "NOT_FOUND", message: "That question was not found." };

    const features = one<{ id: string; label: string | null; rejection_reason: string | null; label_status: string; labeled_at: number | null; analysis_mode: string }>(
      "SELECT id, label, rejection_reason, label_status, labeled_at, analysis_mode FROM scan_features WHERE report_id = ? AND user_id = ?",
      [request.report_id, input.userId],
    );
    const base = { userId: input.userId, domain: request.domain, requestId: request.id, outcome, reason, now };

    if (!features || features.analysis_mode !== "live") {
      record({ ...base, scanFeaturesId: features?.id ?? null, status: "refused", statusReason: "No live scan data is stored for the scan this question was about." });
      run("UPDATE feedback_requests SET state = 'closed', updated_at = ? WHERE id = ?", [now, request.id]);
      return { ok: false, code: "CONFLICT", message: "We could not link your answer to a scan, so it was not used. Thank you anyway." };
    }
    const withRow = { ...base, scanFeaturesId: features.id };

    if (outcome === "not_applied") {
      if (request.state !== "open") {
        record({ ...withRow, status: "refused", statusReason: "The site already has an answer; 'not applied yet' cannot replace it." });
        return { ok: false, code: "CONFLICT", message: "You already answered for this site." };
      }
      const again = request.ask_count < MAX_ASKS;
      run(
        `UPDATE feedback_requests SET state = ?, due_at = ?, ask_count = ask_count + ?, email_status = 'waiting', email_attempts = 0,
                email_next_at = NULL, email_error = NULL, answered_at = ?, updated_at = ? WHERE id = ?`,
        [again ? "open" : "closed", again ? now + FEEDBACK_DELAY_DAYS * DAY : request.due_at, again ? 1 : 0, now, now, request.id],
      );
      record({ ...withRow, status: "recorded", statusReason: again ? `Not applied yet; asking again in ${FEEDBACK_DELAY_DAYS} days.` : "Not applied yet; that was the last time we ask." });
      return { ok: true, status: "recorded", message: again ? `Thanks — we'll ask again in ${FEEDBACK_DELAY_DAYS} days.` : "Thanks — we won't ask about this site again." };
    }

    // An answer already stands for this scan: a repeat or a correction.
    if (features.label && (features.label_status === "accepted" || features.label_status === "deferred")) {
      const sameReason = outcome !== "rejected" || reason === null || reason === features.rejection_reason;
      if (features.label === outcome && sameReason) {
        record({ ...withRow, status: "duplicate", statusReason: "Same answer as before; nothing changed." });
        return { ok: true, status: "duplicate", message: "We already have that answer — thank you." };
      }
      const corrections = one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM ml_feedback WHERE scan_features_id = ? AND status IN ('accepted', 'deferred', 'superseded')",
        [features.id],
      )?.n ?? 0;
      if (corrections >= 2) {
        record({ ...withRow, status: "refused", statusReason: "Second correction for the same scan; only one is allowed." });
        return { ok: false, code: "CONFLICT", message: "This answer was already corrected once. Contact support if it is still wrong." };
      }
      if (now - (features.labeled_at ?? 0) > CORRECTION_WINDOW_MS) {
        record({ ...withRow, status: "refused", statusReason: "Correction more than 7 days after the first answer." });
        return { ok: false, code: "CONFLICT", message: "Answers can be corrected within 7 days. Contact support if it is wrong." };
      }
      run("UPDATE ml_feedback SET status = 'superseded', status_reason = status_reason || ' Corrected later.' WHERE scan_features_id = ? AND status IN ('accepted', 'deferred')", [features.id]);
    } else if (request.state !== "open") {
      record({ ...withRow, status: "refused", statusReason: "The question was closed." });
      return { ok: false, code: "CONFLICT", message: "This question is closed." };
    }

    const young = now - input.accountCreatedAt < MIN_ACCOUNT_AGE_DAYS * DAY;
    const status = young ? "deferred" : "accepted";
    run(
      `UPDATE scan_features SET label = ?, rejection_reason = ?, label_source = 'user_feedback', label_status = ?, labeled_at = ?, label_weight = 1, weight_note = NULL
        WHERE id = ?`,
      [outcome, outcome === "rejected" ? reason ?? "other" : null, status, now, features.id],
    );
    run("UPDATE feedback_requests SET state = 'answered', answered_at = ?, updated_at = ? WHERE id = ?", [now, now, request.id]);
    record({
      ...withRow,
      status,
      statusReason: young
        ? `Account younger than ${MIN_ACCOUNT_AGE_DAYS} days; used for training once it is older.`
        : features.label
          ? "Correction within 7 days; replaces the earlier answer."
          : "Accepted.",
    });
    return { ok: true, status, message: "Thank you — your answer helps make the estimates more accurate for everyone." };
  });
}

/**
 * Deferred answers from accounts that have since turned 3 days old become
 * accepted. Run by the background job.
 */
export function promoteDeferred(now = Date.now()): number {
  const cutoff = now - MIN_ACCOUNT_AGE_DAYS * DAY;
  return tx(() => {
    const rows = many<{ id: string }>(
      `SELECT s.id FROM scan_features s JOIN users u ON u.id = s.user_id
        WHERE s.label_status = 'deferred' AND u.created_at <= ? AND u.status = 'active'`,
      [cutoff],
    );
    for (const row of rows) {
      run("UPDATE scan_features SET label_status = 'accepted' WHERE id = ?", [row.id]);
      run(
        "UPDATE ml_feedback SET status = 'accepted', status_reason = status_reason || ' Accepted once the account was old enough.', decided_at = ? WHERE scan_features_id = ? AND status = 'deferred'",
        [now, row.id],
      );
    }
    return rows.length;
  });
}

/* ── admin views ────────────────────────────────────────────────── */

export type FeedbackLogRow = {
  id: string;
  domain: string;
  outcome: FeedbackOutcome;
  rejection_reason: string | null;
  status: string;
  status_reason: string;
  created_at: number;
};

export function recentFeedback(limit = 30): FeedbackLogRow[] {
  return many<FeedbackLogRow>(
    "SELECT id, domain, outcome, rejection_reason, status, status_reason, created_at FROM ml_feedback ORDER BY created_at DESC, rowid DESC LIMIT ?",
    [limit],
  );
}

export function feedbackCounts(now = Date.now()): { open: number; due: number; answered: number; emailsSent: number; emailsFailed: number } {
  const row = one<{ open: number; due: number; answered: number; sent: number; failed: number }>(
    `SELECT SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN state = 'open' AND due_at <= ? THEN 1 ELSE 0 END) AS due,
            SUM(CASE WHEN state = 'answered' THEN 1 ELSE 0 END) AS answered,
            SUM(CASE WHEN email_status = 'sent' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN email_status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM feedback_requests`,
    [now],
  );
  return { open: row?.open ?? 0, due: row?.due ?? 0, answered: row?.answered ?? 0, emailsSent: row?.sent ?? 0, emailsFailed: row?.failed ?? 0 };
}
