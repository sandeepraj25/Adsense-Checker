import { requireAdminApi } from "@/lib/auth/guard";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import {
  MAX_GRACE_MINUTES,
  MIN_GRACE_MINUTES,
  alertEmailSetting,
  graceMinutes,
  normalizeAlertEmail,
  setAlertEmail,
  setGraceMinutes,
} from "@/lib/alerts/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  return jsonOk({ alertEmail: alertEmailSetting(), graceMinutes: graceMinutes() });
}

/**
 * Body: { alertEmail?: string ("" turns alerts off), graceMinutes?: number }
 * Administrators only; the address is validated here, not just in the form.
 */
export async function PATCH(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const changes: string[] = [];
  if (body.alertEmail !== undefined) {
    if (body.alertEmail === "" || body.alertEmail === null) {
      setAlertEmail(null, guard.admin.email);
      changes.push("alert email cleared — alerts off");
    } else {
      const email = normalizeAlertEmail(body.alertEmail);
      if (!email) {
        return jsonError("VALIDATION_ERROR", "Enter a valid email address, like alerts@yourdomain.com.", {
          fields: { alertEmail: "Enter a valid email address" },
        });
      }
      setAlertEmail(email, guard.admin.email);
      changes.push(`alert email set to ${email}`);
    }
  }
  if (body.graceMinutes !== undefined) {
    const minutes = typeof body.graceMinutes === "number" ? body.graceMinutes : Number.parseInt(String(body.graceMinutes), 10);
    if (!Number.isInteger(minutes) || minutes < MIN_GRACE_MINUTES || minutes > MAX_GRACE_MINUTES) {
      return jsonError("VALIDATION_ERROR", `The wait must be a whole number of minutes from ${MIN_GRACE_MINUTES} to ${MAX_GRACE_MINUTES}.`, {
        fields: { graceMinutes: "Out of range" },
      });
    }
    setGraceMinutes(minutes, guard.admin.email);
    changes.push(`abandonment wait set to ${minutes} minutes`);
  }
  if (changes.length === 0) return jsonError("VALIDATION_ERROR", "Nothing to change.");

  recordAdminAction({
    admin: { id: guard.admin.id, email: guard.admin.email },
    action: "settings.alerts_updated",
    targetType: "system",
    targetLabel: "Payment & checkout alerts",
    detail: changes.join("; "),
  });
  return jsonOk({ alertEmail: alertEmailSetting(), graceMinutes: graceMinutes() });
}
