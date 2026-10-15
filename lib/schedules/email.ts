import { many, one, run } from "@/lib/db";
import { emailStatus, sendEmail, type EmailMessage } from "@/lib/email";
import { escapeHtml, layout } from "@/lib/email/templates";
import { APP_URL } from "@/lib/env";

import type { ScanDiff } from "@/lib/analysis/insights/history";

/**
 * The "your weekly rescan found changes" email. Queued on the run row
 * (schedule_runs.email_status = pending) only when findings changed in a
 * meaningful way, then sent by the job: claimed first, retried on a
 * temporary failure up to five times, never marked sent unless the
 * provider accepted it.
 */

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
const PRODUCT = "AdSense Eligibility Checker";

export function changeEmail(input: { to: string; name: string; domain: string; reportUrl: string; score: number; diff: ScanDiff }): EmailMessage {
  const d = input.diff;
  const subject = `Weekly rescan of ${input.domain}: ${d.appeared.length + d.worsened.length} new, ${d.resolved.length} fixed`;
  const first = input.name.trim().split(/\s+/)[0] || "there";
  const delta = d.scoreDelta === 0 ? "unchanged" : `${d.scoreDelta > 0 ? "up" : "down"} ${Math.abs(d.scoreDelta)}`;
  const list = (title: string, lines: Array<{ label: string }>) => (lines.length ? [`${title}:`, ...lines.slice(0, 8).map((l) => `  • ${l.label}`), ...(lines.length > 8 ? [`  • and ${lines.length - 8} more`] : [])] : []);
  const text = [
    `Hi ${first},`,
    "",
    `Your weekly rescan of ${input.domain} is ready. Score ${Math.round(d.previous.score)} → ${Math.round(input.score)} (${delta}).`,
    "",
    ...list("New problems", [...d.appeared, ...d.worsened]),
    ...list("Fixed", d.resolved),
    "",
    `Full report: ${input.reportUrl}`,
    "",
    "You get this email only when findings change. Turn weekly rescans off from the report page.",
    "",
    `— ${PRODUCT}`,
  ].join("\n");
  const items = (title: string, lines: Array<{ label: string }>, colour: string) =>
    lines.length
      ? `<p style="margin:16px 0 6px;font-size:14px;font-weight:600;color:${colour};">${escapeHtml(title)}</p><ul style="margin:0;padding-left:18px;font-size:14px;line-height:22px;color:#3f3f46;">${lines
          .slice(0, 8)
          .map((l) => `<li>${escapeHtml(l.label)}</li>`)
          .join("")}${lines.length > 8 ? `<li>and ${lines.length - 8} more</li>` : ""}</ul>`
      : "";
  const html = layout(
    subject,
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:28px;color:#18181b;">Weekly rescan: ${escapeHtml(input.domain)}</h1>
<p style="margin:0 0 4px;font-size:15px;line-height:22px;color:#52525b;">Score ${Math.round(d.previous.score)} → <strong>${Math.round(input.score)}</strong> (${escapeHtml(delta)}).</p>
${items("New problems", [...d.appeared, ...d.worsened], "#be123c")}
${items("Fixed", d.resolved, "#047857")}
<p style="margin:20px 0;"><a href="${escapeHtml(input.reportUrl)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;border-radius:8px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Open the report</a></p>`,
    `You get this email only when findings change. Turn weekly rescans off from the report page.`,
  );
  return { to: input.to, subject, text, html };
}

/** Sends queued change emails. Returns a tally by outcome. */
export async function processRescanEmails(now = Date.now(), limit = 25): Promise<Record<string, number>> {
  const due = many<{ id: string; user_id: string; domain: string; report_id: string | null; changes_json: string | null; email_attempts: number }>(
    `SELECT id, user_id, domain, report_id, changes_json, email_attempts FROM schedule_runs
      WHERE (email_status IN ('pending', 'retry') OR (email_status = 'sending' AND email_locked_until < ?))
        AND (email_next_at IS NULL OR email_next_at <= ?)
      ORDER BY created_at ASC LIMIT ?`,
    [now, now, limit],
  );
  const tally: Record<string, number> = {};
  for (const row of due) {
    const claimed = run(
      `UPDATE schedule_runs SET email_status = 'sending', email_locked_until = ?, email_attempts = email_attempts + 1
        WHERE id = ? AND (email_status IN ('pending', 'retry') OR (email_status = 'sending' AND email_locked_until < ?))`,
      [now + 2 * 60_000, row.id, now],
    ).changes;
    if (claimed !== 1) continue;
    const attempts = row.email_attempts + 1;
    const finish = (status: "sent" | "retry" | "failed" | "skipped", error: string | null) => {
      run(
        "UPDATE schedule_runs SET email_status = ?, email_error = ?, email_locked_until = NULL, email_next_at = ? WHERE id = ?",
        [status, error, status === "retry" ? now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]! : null, row.id],
      );
      tally[status] = (tally[status] ?? 0) + 1;
    };
    const user = one<{ name: string; email: string; status: string }>("SELECT name, email, status FROM users WHERE id = ?", [row.user_id]);
    const report = row.report_id ? one<{ score: number }>("SELECT score FROM reports WHERE id = ? AND user_id = ?", [row.report_id, row.user_id]) : null;
    let diff: ScanDiff | null = null;
    try {
      diff = row.changes_json ? (JSON.parse(row.changes_json) as ScanDiff) : null;
    } catch {
      diff = null;
    }
    if (!user || user.status !== "active" || !report || !diff) {
      finish("skipped", !user || user.status !== "active" ? "Account is blocked or no longer exists." : "The report or its changes are no longer available.");
      continue;
    }
    const provider = emailStatus();
    if (!provider.configured) {
      finish(attempts >= MAX_ATTEMPTS ? "failed" : "retry", `Email delivery isn't configured: ${provider.problem}`.slice(0, 300));
      continue;
    }
    try {
      const result = await sendEmail(changeEmail({ to: user.email, name: user.name, domain: row.domain, reportUrl: `${APP_URL}/dashboard/reports/${row.report_id}`, score: report.score, diff }));
      if (result.ok) finish("sent", null);
      else finish(result.transient && attempts < MAX_ATTEMPTS ? "retry" : "failed", `${result.transient ? "Temporary" : "Rejected"}: ${result.reason}`.slice(0, 300));
    } catch (error) {
      finish(attempts < MAX_ATTEMPTS ? "retry" : "failed", `Send error: ${error instanceof Error ? error.name : "unknown"}`);
    }
  }
  return tally;
}
