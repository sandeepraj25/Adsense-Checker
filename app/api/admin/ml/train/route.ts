import { requireAdminApi } from "@/lib/auth/guard";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, jsonServerError } from "@/lib/http";
import { runTraining } from "@/lib/ml/train";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * "Retrain now" from Admin → Prediction model. Runs the same training as
 * the nightly job — same data rules, same acceptance criteria — and
 * answers with its outcome. A run already in progress answers "busy".
 */
export async function POST() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  if (!rateLimit(`admin-ml-train:${guard.admin.id}`, 6, 10 * 60_000).ok) {
    return jsonError("RATE_LIMITED", "Training was started several times in a row. Wait a few minutes.");
  }
  try {
    const result = await runTraining({ trigger: "manual", actor: guard.admin.email });
    recordAdminAction({
      admin: { id: guard.admin.id, email: guard.admin.email },
      action: "ml.train",
      targetType: "system",
      targetId: "version" in result ? result.id : null,
      targetLabel: "version" in result ? result.version : "Prediction model",
      detail: `${result.outcome}: ${result.message}`,
    });
    if (result.outcome === "busy") return jsonError("CONFLICT", result.message);
    return jsonOk({ outcome: result.outcome, message: result.message, version: "version" in result ? result.version : null });
  } catch (error) {
    return jsonServerError("admin/ml/train", error);
  }
}
