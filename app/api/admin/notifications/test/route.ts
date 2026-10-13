import { alertEmail } from "@/lib/alerts/settings";
import { requireAdminApi } from "@/lib/auth/guard";
import { emailStatus, sendEmail } from "@/lib/email";
import { layout } from "@/lib/email/templates";
import { jsonError, jsonOk } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Sends a short test message to the alert address and reports what the provider said. */
export async function POST() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  if (!rateLimit(`alerts-test:${guard.admin.id}`, 5, 10 * 60_000).ok) return jsonError("RATE_LIMITED", "Try again in a few minutes.");
  const to = alertEmail();
  if (!to) return jsonError("VALIDATION_ERROR", "Save an alert email first.");
  const status = emailStatus();
  if (!status.configured) return jsonError("EMAIL_UNCONFIGURED", `Email delivery isn't configured: ${status.problem}`);
  const subject = "[AdSense Checker] Test alert";
  const result = await sendEmail({
    to,
    subject,
    text: "This is a test of payment and checkout alerts. If you can read this, alerts will reach this address.",
    html: layout(subject, `<h1 style="margin:0 0 8px;font-size:20px;color:#18181b;">Alerts reach this address</h1><p style="margin:0;font-size:15px;line-height:22px;color:#52525b;">This is a test of payment and checkout alerts.</p>`, `Sent from Admin → Notifications by ${guard.admin.email}.`),
  });
  if (!result.ok) return jsonError("EMAIL_DELIVERY_FAILED", `The provider did not accept it: ${result.reason}`);
  return jsonOk({ provider: result.provider, delivered: result.provider !== "console" });
}
