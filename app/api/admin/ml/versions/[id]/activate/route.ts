import { requireAdminApi } from "@/lib/auth/guard";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, jsonServerError } from "@/lib/http";
import { rollbackTo } from "@/lib/ml/train";

export const runtime = "nodejs";

/** Rollback: restore a model version that was active before. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { id } = await context.params;
  try {
    const result = rollbackTo(id, guard.admin.email);
    if (!result.ok) return jsonError("CONFLICT", result.message);
    recordAdminAction({
      admin: { id: guard.admin.id, email: guard.admin.email },
      action: "ml.rollback",
      targetType: "system",
      targetId: id,
      targetLabel: result.version,
      detail: result.replaced ? `Replaced ${result.replaced}` : null,
    });
    return jsonOk({ version: result.version, replaced: result.replaced });
  } catch (error) {
    return jsonServerError("admin/ml/activate", error);
  }
}
