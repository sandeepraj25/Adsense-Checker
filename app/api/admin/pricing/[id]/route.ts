import { requireAdminApi } from "@/lib/auth/guard";
import { adminStats, recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";
import { formatMoney, parseMajorToMinor } from "@/lib/money";
import { getPlan, updatePlan, type PlanPatch } from "@/lib/plan-catalogue";
import { isPlanId } from "@/lib/plans";

export const runtime = "nodejs";

/**
 * Sets one plan's INR and/or USD price — nothing else about the plan.
 *
 * Body: { inr?: "399.00", usd?: "5.99" | "" | null, confirmed?: true }
 *   · a field left out is not touched, so editing USD never moves INR
 *   · usd "" or null withdraws the plan from dollar checkout
 *   · amounts are decimal strings, parsed with integer maths into minor
 *     units (paise / cents); at most two decimals, never negative
 *
 * A change is only written with `confirmed: true`. Without it the route
 * answers 409 with exactly what would change, so a client — the admin
 * page, or a script — has to look at the summary and send it again.
 *
 * Existing subscriptions, payments and invoices are not touched: each
 * keeps the amount and currency it was bought in.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const admin = { id: guard.admin.id, email: guard.admin.email };

  const { id } = await context.params;
  if (!isPlanId(id)) return jsonError("NOT_FOUND", "No such plan.");

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const before = getPlan(id);
  if (!before) return jsonError("NOT_FOUND", "No such plan.");

  const patch: PlanPatch = {};
  const fields: Record<string, string> = {};

  if (body.inr !== undefined) {
    const inr = parseMajorToMinor(body.inr);
    if (inr === null) fields.inr = "Enter an amount like 399 or 399.50 — no minus sign, at most two decimals.";
    else patch.amountPaise = inr;
  }
  if (body.usd !== undefined) {
    if (body.usd === null || body.usd === "") {
      patch.usdAmountCents = null;
    } else {
      const usd = parseMajorToMinor(body.usd);
      if (usd === null) fields.usd = "Enter an amount like 5.99 — no minus sign, at most two decimals.";
      else patch.usdAmountCents = usd;
    }
  }
  if (Object.keys(fields).length > 0) {
    return jsonError("VALIDATION_ERROR", "Check the highlighted prices.", { fields });
  }

  if (id === "free" && ((patch.amountPaise ?? 0) !== 0 || (patch.usdAmountCents ?? 0) !== 0)) {
    return jsonError("VALIDATION_ERROR", "The Free plan stays free in every currency.");
  }

  const inrChanged = patch.amountPaise !== undefined && patch.amountPaise !== before.amountPaise;
  const usdChanged = patch.usdAmountCents !== undefined && patch.usdAmountCents !== before.usdAmountCents;
  if (!inrChanged && !usdChanged) {
    return jsonOk({ plan: before, changed: [] });
  }

  const show = (minor: number | null, currency: "INR" | "USD") =>
    minor === null ? "not offered" : formatMoney(minor, currency);
  const summary: string[] = [];
  if (inrChanged) summary.push(`INR ${show(before.amountPaise, "INR")} → ${show(patch.amountPaise!, "INR")}`);
  if (usdChanged) {
    summary.push(`USD ${show(before.usdAmountCents, "USD")} → ${show(patch.usdAmountCents ?? null, "USD")}`);
  }

  if (body.confirmed !== true) {
    return jsonError("CONFIRMATION_REQUIRED", "Confirm this price change to save it.", {
      extra: {
        summary: summary.join("; "),
        activeSubscribers: adminStats().plans[id] ?? 0,
      },
    });
  }

  try {
    const result = updatePlan(id, patch, admin);
    if (!result.ok) return jsonError("VALIDATION_ERROR", result.error);

    if (result.changed.length > 0) {
      recordAdminAction({
        admin,
        action: "plan.price_changed",
        targetType: "plan",
        targetId: id,
        targetLabel: result.after.name,
        detail: result.changed.join("; "),
      });
    }
    return jsonOk({ plan: result.after, changed: result.changed });
  } catch (error) {
    return jsonServerError("admin/pricing/patch", error);
  }
}
