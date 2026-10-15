import { many, one, run } from "@/lib/db";
import { emailStatus, sendEmail, type EmailMessage } from "@/lib/email";
import { escapeHtml, layout } from "@/lib/email/templates";
import { APP_URL } from "@/lib/env";

/**
 * The one email per feedback prompt: sent when the prompt falls due,
 * through the project's mailer. Each prompt is claimed with a guarded
 * UPDATE before sending, so the background tick and the scheduled job can
 * both run without sending it twice. Temporary failures retry with a
 * growing wait, up to five attempts; nothing is marked sent unless the
 * provider accepted it. Blocked or deleted accounts are skipped.
 */

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
const LOCK_MS = 2 * 60_000;
const PRODUCT = "AdSense Eligibility Checker";

export function feedbackEmail(input: { to: string; name: string; domain: string; link: string }): EmailMessage {
  const subject = `Did AdSense approve ${input.domain}?`;
  const first = input.name.trim().split(/\s+/)[0] || "there";
  const text = [
    `Hi ${first},`,
    "",
    `You scanned ${input.domain} with ${PRODUCT} about two weeks ago. Did AdSense approve it?`,
    "",
    "Answer in one click on your dashboard — Approved, Rejected, or Not applied yet:",
    input.link,
    "",
    "Your answer is used, without your site's content, to make readiness estimates more accurate for everyone. We ask once per site; if you haven't applied yet we'll check back in two weeks, at most three times.",
    "",
    `— ${PRODUCT}`,
  ].join("\n");
  const html = layout(
    subject,
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:28px;color:#18181b;">Did AdSense approve ${escapeHtml(input.domain)}?</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:22px;color:#52525b;">Hi ${escapeHtml(first)}, you scanned this site about two weeks ago. One click on your dashboard tells us how the application went.</p>
<p style="margin:0 0 20px;"><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;border-radius:8px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Answer on your dashboard</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:20px;color:#52525b;">Your answer is used — without your site's content — to make readiness estimates more accurate. If you haven't applied yet, we'll check back in two weeks, at most three times.</p>`,
    `You received this because you scanned ${input.domain} with ${PRODUCT}.`,
  );
  return { to: input.to, subject, text, html };
}

type Due = { id: string; user_id: string; domain: string; email_attempts: number };

/** Sends the emails for prompts that are due. Returns a tally by outcome. */
export async function processFeedbackEmails(now = Date.now(), limit = 25): Promise<Record<string, number>> {
  const due = many<Due>(
    `SELECT id, user_id, domain, email_attempts FROM feedback_requests
      WHERE state = 'open' AND due_at <= ?
        AND (email_status IN ('waiting', 'retry') OR (email_status = 'sending' AND email_locked_until < ?))
        AND (email_next_at IS NULL OR email_next_at <= ?)
      ORDER BY due_at ASC LIMIT ?`,
    [now, now, now, limit],
  );
  const tally: Record<string, number> = {};
  const count = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);

  for (const row of due) {
    const claimed = run(
      `UPDATE feedback_requests SET email_status = 'sending', email_locked_until = ?, email_attempts = email_attempts + 1, updated_at = ?
        WHERE id = ? AND state = 'open' AND (email_status IN ('waiting', 'retry') OR (email_status = 'sending' AND email_locked_until < ?))`,
      [now + LOCK_MS, now, row.id, now],
    ).changes;
    if (claimed !== 1) continue;
    const attempts = row.email_attempts + 1;
    const finish = (status: "sent" | "retry" | "failed" | "skipped", error: string | null) => {
      const next = status === "retry" ? now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]! : null;
      run(
        `UPDATE feedback_requests SET email_status = ?, email_locked_until = NULL, email_error = ?, email_next_at = ?,
                email_sent_at = CASE WHEN ? = 'sent' THEN ? ELSE email_sent_at END, updated_at = ? WHERE id = ?`,
        [status, error, next, status, now, now, row.id],
      );
      count(status);
    };

    const user = one<{ name: string; email: string; status: string }>("SELECT name, email, status FROM users WHERE id = ?", [row.user_id]);
    if (!user || user.status !== "active") {
      finish("skipped", "Account is blocked or no longer exists.");
      continue;
    }
    const provider = emailStatus();
    if (!provider.configured) {
      finish(attempts >= MAX_ATTEMPTS ? "failed" : "retry", `Email delivery isn't configured: ${provider.problem}`.slice(0, 300));
      continue;
    }
    try {
      const result = await sendEmail(feedbackEmail({ to: user.email, name: user.name, domain: row.domain, link: `${APP_URL}/dashboard#adsense-feedback` }));
      if (result.ok) finish("sent", null);
      else finish(result.transient && attempts < MAX_ATTEMPTS ? "retry" : "failed", `${result.transient ? "Temporary" : "Rejected"}: ${result.reason}`.slice(0, 300));
    } catch (error) {
      finish(attempts < MAX_ATTEMPTS ? "retry" : "failed", `Send error: ${error instanceof Error ? error.name : "unknown"}`);
    }
  }
  return tally;
}
