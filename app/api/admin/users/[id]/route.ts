import { trackServerEvent } from "@/lib/analytics/store";
import { requireAdminApi } from "@/lib/auth/guard";
import {
  EmailTakenError,
  blockUser,
  countAdmins,
  deleteUser,
  findUserById,
  setUserRole,
  summariseUserFootprint,
  unblockUser,
  updateUserEmail,
  updateUserName,
} from "@/lib/db/accounts";
import { recordAdminAction } from "@/lib/db/admin";
import {
  assignPlan,
  getActiveSubscription,
  getLatestSubscription,
  resetSubscriptionUsage,
  setSubscriptionExpiry,
  setSubscriptionLimits,
  setSubscriptionNote,
  setSubscriptionStatus,
} from "@/lib/db/billing";
import {
  int,
  jsonError,
  jsonOk,
  jsonServerError,
  readJson,
  str,
} from "@/lib/http";
import { formatDate } from "@/lib/format";
import { getPlan } from "@/lib/plan-catalogue";
import { validateEmail, validateName, normalizeEmail } from "@/lib/validate";

export const runtime = "nodejs";

/**
 * Every administrative change to one account.
 *
 * Two things are true of every branch below. The first is that
 * `requireAdminApi()` runs before anything else — this endpoint is the
 * real control, and hiding the buttons in the panel is not. The second is
 * that every successful mutation is written to the audit log with the
 * admin who did it, the account it touched and what changed, because the
 * value of that log is entirely in the cases where nobody remembers.
 *
 * An admin cannot block, demote or delete their own account, and cannot
 * remove the last remaining administrator. Both refusals exist because
 * the alternative is an install with no way back into /admin.
 */

const DAY_MS = 86_400_000;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const admin = { id: guard.admin.id, email: guard.admin.email };

  const { id } = await context.params;
  const target = findUserById(id);
  if (!target) return jsonError("NOT_FOUND", "No such account.");

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const self = target.id === admin.id;
  const action = str(body.action);

  try {
    switch (action) {
      /* ── identity ───────────────────────────────────────────── */

      case "profile": {
        const name = str(body.name).trim();
        const email = normalizeEmail(str(body.email));
        const fields: Record<string, string> = {};

        if (name) {
          const problem = validateName(name);
          if (problem) fields.name = problem;
        }
        if (email) {
          const problem = validateEmail(email);
          if (problem) fields.email = problem;
        }
        if (Object.keys(fields).length > 0) {
          return jsonError("VALIDATION_ERROR", "Check the highlighted fields.", {
            fields,
          });
        }
        if (!name && !email) {
          return jsonError("VALIDATION_ERROR", "Nothing to change.");
        }

        const notes: string[] = [];
        if (name && name !== target.name) {
          updateUserName(target.id, name);
          notes.push(`name ${target.name} → ${name}`);
        }
        if (email && email !== target.email) {
          updateUserEmail(target.id, email);
          notes.push(`email ${target.email} → ${email}`);
        }
        if (notes.length === 0) return jsonOk({ changed: [] });

        recordAdminAction({
          admin,
          action: "user.profile_updated",
          targetType: "user",
          targetId: target.id,
          targetLabel: email || target.email,
          detail: notes.join("; "),
        });
        return jsonOk({ changed: notes });
      }

      /* ── account status ─────────────────────────────────────── */

      case "block": {
        if (self) {
          return jsonError(
            "VALIDATION_ERROR",
            "You cannot suspend your own account.",
          );
        }
        if (target.isAdmin && countAdmins() <= 1) {
          return jsonError(
            "VALIDATION_ERROR",
            "That is the only administrator account. Promote someone else first.",
          );
        }

        const reason = str(body.reason).trim();
        // Blocking also drops the account's sessions, so the person is
        // signed out rather than left browsing on an accepted cookie.
        const changed = blockUser(target.id, reason || null);
        if (!changed) {
          return jsonError("VALIDATION_ERROR", "That account is already suspended.");
        }

        recordAdminAction({
          admin,
          action: "user.blocked",
          targetType: "user",
          targetId: target.id,
          targetLabel: target.email,
          detail: reason || "No reason given",
        });
        return jsonOk({ status: "blocked" });
      }

      case "unblock": {
        const changed = unblockUser(target.id);
        if (!changed) {
          return jsonError("VALIDATION_ERROR", "That account is not suspended.");
        }
        recordAdminAction({
          admin,
          action: "user.unblocked",
          targetType: "user",
          targetId: target.id,
          targetLabel: target.email,
        });
        return jsonOk({ status: "active" });
      }

      /* ── role ───────────────────────────────────────────────── */

      case "role": {
        const role = str(body.role);
        if (role !== "user" && role !== "admin") {
          return jsonError("VALIDATION_ERROR", "Role must be user or admin.");
        }
        if (self) {
          return jsonError(
            "VALIDATION_ERROR",
            "You cannot change your own role. Ask another administrator.",
          );
        }
        if (role === "user" && target.isAdmin && countAdmins() <= 1) {
          return jsonError(
            "VALIDATION_ERROR",
            "That is the only administrator account.",
          );
        }
        if (role === target.role) return jsonOk({ role });

        setUserRole(target.id, role);
        recordAdminAction({
          admin,
          action: role === "admin" ? "user.promoted" : "user.demoted",
          targetType: "user",
          targetId: target.id,
          targetLabel: target.email,
          detail: `role ${target.role} → ${role}`,
        });
        return jsonOk({ role });
      }

      /* ── plan ───────────────────────────────────────────────── */

      case "plan": {
        const plan = getPlan(str(body.planId));
        if (!plan) return jsonError("VALIDATION_ERROR", "Choose one of the plans.");

        const months = int(body.months) ?? 1;
        if (months < 1 || months > 36) {
          return jsonError("VALIDATION_ERROR", "Months must be between 1 and 36.");
        }

        const before = getActiveSubscription(target.id);
        // A new row rather than an edit: the billing history has to keep
        // showing what was actually sold, and when an admin changed it.
        const subscription = assignPlan({
          userId: target.id,
          plan,
          note: `Set to ${plan.name} by ${admin.email}`,
          months,
        });

        recordAdminAction({
          admin,
          action: "user.plan_changed",
          targetType: "subscription",
          targetId: subscription.id,
          targetLabel: target.email,
          detail:
            `plan ${before?.planId ?? "none"} → ${plan.id}` +
            ` (${plan.scanLimit} scans/month, ${months} month${months === 1 ? "" : "s"},` +
            ` expires ${formatDate(subscription.expiresAt)}, no charge)`,
        });
        return jsonOk({
          subscriptionId: subscription.id,
          planId: subscription.planId,
          expiresAt: subscription.expiresAt,
        });
      }

      /* ── subscription adjustments ───────────────────────────── */

      case "expiry": {
        const subscription = getLatestSubscription(target.id);
        if (!subscription) {
          return jsonError("VALIDATION_ERROR", "That account has no subscription.");
        }

        // Either an absolute date from a date input, or a nudge in days.
        const days = int(body.days);
        const at = int(body.expiresAt);
        const expiresAt =
          at !== null
            ? at
            : days !== null
              ? subscription.expiresAt + days * DAY_MS
              : null;
        if (expiresAt === null) {
          return jsonError("VALIDATION_ERROR", "Send expiresAt or days.");
        }
        if (expiresAt < Date.now() - 10 * 365 * DAY_MS || expiresAt > Date.now() + 10 * 365 * DAY_MS) {
          return jsonError("VALIDATION_ERROR", "That date looks like a mistake.");
        }

        setSubscriptionExpiry(subscription.id, expiresAt);
        recordAdminAction({
          admin,
          action: "subscription.expiry_changed",
          targetType: "subscription",
          targetId: subscription.id,
          targetLabel: target.email,
          detail: `expiry ${formatDate(subscription.expiresAt)} → ${formatDate(expiresAt)}`,
        });
        return jsonOk({ expiresAt });
      }

      case "limits": {
        const subscription = getLatestSubscription(target.id);
        if (!subscription) {
          return jsonError("VALIDATION_ERROR", "That account has no subscription.");
        }

        const scanLimit = int(body.scanLimit);
        const siteLimit = int(body.siteLimit);
        if (scanLimit === null && siteLimit === null) {
          return jsonError("VALIDATION_ERROR", "Send scanLimit or siteLimit.");
        }
        if (scanLimit !== null && (scanLimit < 1 || scanLimit > 100_000)) {
          return jsonError("VALIDATION_ERROR", "Scan limit must be between 1 and 100000.");
        }
        if (siteLimit !== null && (siteLimit < 1 || siteLimit > 10_000)) {
          return jsonError("VALIDATION_ERROR", "Website limit must be between 1 and 10000.");
        }

        setSubscriptionLimits(subscription.id, {
          ...(scanLimit !== null ? { scanLimit } : {}),
          ...(siteLimit !== null ? { siteLimit } : {}),
        });

        const notes: string[] = [];
        if (scanLimit !== null && scanLimit !== subscription.scanLimit) {
          notes.push(`scans/month ${subscription.scanLimit} → ${scanLimit}`);
        }
        if (siteLimit !== null && siteLimit !== subscription.siteLimit) {
          notes.push(`websites ${subscription.siteLimit ?? "∞"} → ${siteLimit}`);
        }
        recordAdminAction({
          admin,
          action: "subscription.limits_changed",
          targetType: "subscription",
          targetId: subscription.id,
          targetLabel: target.email,
          detail: notes.join("; ") || "no effective change",
        });
        return jsonOk({ scanLimit, siteLimit });
      }

      case "reset_usage": {
        const subscription = getLatestSubscription(target.id);
        if (!subscription) {
          return jsonError("VALIDATION_ERROR", "That account has no subscription.");
        }
        resetSubscriptionUsage(subscription.id);
        recordAdminAction({
          admin,
          action: "subscription.usage_reset",
          targetType: "subscription",
          targetId: subscription.id,
          targetLabel: target.email,
          detail: `${subscription.scansUsed} scans used → 0, mid-cycle`,
        });
        return jsonOk({ scansUsed: 0 });
      }

      case "subscription_status": {
        const status = str(body.status);
        if (status !== "active" && status !== "expired" && status !== "cancelled") {
          return jsonError(
            "VALIDATION_ERROR",
            "Status must be active, expired or cancelled.",
          );
        }
        const subscription = getLatestSubscription(target.id);
        if (!subscription) {
          return jsonError("VALIDATION_ERROR", "That account has no subscription.");
        }
        // Reactivating something already past its expiry date would put an
        // "active" row on screen that every entitlement check still
        // refuses, which reads as a bug rather than as the truth.
        if (status === "active" && subscription.expiresAt <= Date.now()) {
          return jsonError(
            "VALIDATION_ERROR",
            "That subscription has passed its expiry date. Extend the expiry first.",
          );
        }

        setSubscriptionStatus(subscription.id, status);
        if (status === "cancelled" && subscription.status !== "cancelled") {
          trackServerEvent("subscription_cancelled", {
            key: `cancel:${subscription.id}:${Date.now()}`,
            userId: target.id,
            props: { plan: subscription.planId },
          });
        }
        recordAdminAction({
          admin,
          action: "subscription.status_changed",
          targetType: "subscription",
          targetId: subscription.id,
          targetLabel: target.email,
          detail: `status ${subscription.status} → ${status}`,
        });
        return jsonOk({ status });
      }

      case "note": {
        const subscription = getLatestSubscription(target.id);
        if (!subscription) {
          return jsonError("VALIDATION_ERROR", "That account has no subscription.");
        }
        const note = str(body.note).trim();
        setSubscriptionNote(subscription.id, note || null);
        recordAdminAction({
          admin,
          action: "subscription.note_edited",
          targetType: "subscription",
          targetId: subscription.id,
          targetLabel: target.email,
          detail: note ? note.slice(0, 200) : "note cleared",
        });
        return jsonOk({ note });
      }

      default:
        return jsonError("VALIDATION_ERROR", "Unknown action.");
    }
  } catch (error) {
    if (error instanceof EmailTakenError) {
      return jsonError("EMAIL_TAKEN", "Another account already uses that email.", {
        fields: { email: "Already in use" },
      });
    }
    return jsonServerError("admin/users/patch", error);
  }
}

/**
 * Deletes an account and everything hanging off it.
 *
 * The audit entry is written *before* the delete, because afterwards the
 * counts it records no longer exist anywhere. The row itself survives the
 * user: a log that loses the fact that an account was deleted is not a
 * log. `deleteUser` removes sessions, reports, findings, websites,
 * invoices, payments and subscriptions in dependency order inside one
 * transaction, so nothing is left orphaned.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const admin = { id: guard.admin.id, email: guard.admin.email };

  const { id } = await context.params;
  const target = findUserById(id);
  if (!target) return jsonError("NOT_FOUND", "No such account.");

  if (target.id === admin.id) {
    return jsonError("VALIDATION_ERROR", "You cannot delete your own account.");
  }
  if (target.isAdmin && countAdmins() <= 1) {
    return jsonError(
      "VALIDATION_ERROR",
      "That is the only administrator account.",
    );
  }

  // The panel asks for the email to be typed out. Checking it here too
  // means a stray DELETE from anywhere else cannot wipe an account by id
  // alone.
  const body = await readJson(request);
  const confirm = normalizeEmail(str(body?.confirmEmail));
  if (confirm !== target.email) {
    return jsonError(
      "VALIDATION_ERROR",
      "Type the account's email address to confirm deletion.",
    );
  }

  try {
    const footprint = summariseUserFootprint(target.id);
    recordAdminAction({
      admin,
      action: "user.deleted",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.email,
      detail:
        `${target.name} — ${footprint.reports} reports, ${footprint.websites} websites, ` +
        `${footprint.subscriptions} subscriptions, ${footprint.payments} payments, ` +
        `${footprint.invoices} invoices, ${footprint.sessions} sessions removed`,
    });

    const deleted = deleteUser(target.id);
    if (!deleted) return jsonError("NOT_FOUND", "No such account.");
    return jsonOk({ deleted: true, footprint });
  } catch (error) {
    return jsonServerError("admin/users/delete", error);
  }
}
