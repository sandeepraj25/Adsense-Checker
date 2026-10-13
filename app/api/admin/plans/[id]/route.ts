import { requireAdminApi } from "@/lib/auth/guard";
import { recordAdminAction } from "@/lib/db/admin";
import {
  int,
  bool,
  jsonError,
  jsonOk,
  jsonServerError,
  readJson,
  str,
  strList,
} from "@/lib/http";
import { getPlan, resetPlan, updatePlan, type PlanPatch } from "@/lib/plan-catalogue";
import { isFeatureKey, isPlanId, type FeatureKey } from "@/lib/plans";

export const runtime = "nodejs";

/**
 * Editing what a plan costs and what it includes.
 *
 * Price and limits are read from this table everywhere else in the app —
 * checkout, entitlement, the pricing page — so an edit here is the single
 * change that moves all of them. Nothing is hardcoded in a second place
 * to fall out of step.
 *
 * Live subscriptions are deliberately not rewritten. Each one snapshots
 * the price, the limits and the feature list it was sold with, so this
 * changes what the *next* renewal costs and nothing about what somebody
 * has already paid for. Silently re-pricing a running subscription would
 * falsify billing records that a customer has an invoice for.
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

  try {
    if (str(body.action) === "reset") {
      const result = resetPlan(id, admin);
      if (!result.ok) return jsonError("VALIDATION_ERROR", result.error);
      if (result.changed.length > 0) {
        recordAdminAction({
          admin,
          action: "plan.reset",
          targetType: "plan",
          targetId: id,
          targetLabel: result.after.name,
          detail: result.changed.join("; "),
        });
      }
      return jsonOk({ plan: result.after, changed: result.changed });
    }

    const patch: PlanPatch = {};

    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.tagline === "string") patch.tagline = body.tagline;

    // Rupees on the wire, paise in the database. The form asks for rupees
    // because that is what the operator thinks in, and ₹399 typed into a
    // paise field is a hundredfold pricing error waiting to happen.
    const rupees = int(body.priceRupees);
    if (rupees !== null) patch.amountPaise = rupees * 100;
    const paise = int(body.amountPaise);
    if (paise !== null) patch.amountPaise = paise;

    const siteLimit = int(body.siteLimit);
    if (siteLimit !== null) patch.siteLimit = siteLimit;
    const scanLimit = int(body.scanLimit);
    if (scanLimit !== null) patch.scanLimit = scanLimit;

    const active = bool(body.active);
    if (active !== null) patch.active = active;
    const purchasable = bool(body.purchasable);
    if (purchasable !== null) patch.purchasable = purchasable;
    const featured = bool(body.featured);
    if (featured !== null) patch.featured = featured;

    for (const key of ["features", "showcase", "excluded"] as const) {
      const list = strList(body[key]);
      if (!list) continue;
      const unknown = list.filter((value) => !isFeatureKey(value));
      if (unknown.length > 0) {
        return jsonError(
          "VALIDATION_ERROR",
          `Unknown feature: ${unknown.slice(0, 3).join(", ")}.`,
        );
      }
      patch[key] = list.filter(isFeatureKey) as FeatureKey[];
    }

    const highlights = strList(body.highlights);
    if (highlights) {
      patch.highlights = highlights
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 8);
    }

    if (Object.keys(patch).length === 0) {
      return jsonError("VALIDATION_ERROR", "Nothing to change.");
    }

    const before = getPlan(id);
    const result = updatePlan(id, patch, admin);
    if (!result.ok) return jsonError("VALIDATION_ERROR", result.error);

    if (result.changed.length > 0) {
      const priceMoved = before && before.amountPaise !== result.after.amountPaise;
      recordAdminAction({
        admin,
        // A price change is the entry an operator goes looking for months
        // later, so it gets its own action name rather than being buried
        // in a generic "plan updated".
        action: priceMoved ? "plan.price_changed" : "plan.updated",
        targetType: "plan",
        targetId: id,
        targetLabel: result.after.name,
        detail: result.changed.join("; "),
      });
    }

    return jsonOk({ plan: result.after, changed: result.changed });
  } catch (error) {
    return jsonServerError("admin/plans/patch", error);
  }
}
