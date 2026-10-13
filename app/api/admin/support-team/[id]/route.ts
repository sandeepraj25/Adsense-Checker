import { AgentError, deleteAgent, findAgent, updateAgent } from "@/lib/chat/service";
import { readAgentInput } from "@/lib/chat/team-input";
import { requireAdminApi } from "@/lib/auth/guard";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";

export const runtime = "nodejs";

function describe(before: NonNullable<ReturnType<typeof findAgent>>, after: NonNullable<ReturnType<typeof findAgent>>): string {
  const notes: string[] = [];
  if (before.displayName !== after.displayName) notes.push(`name ${before.displayName} → ${after.displayName}`);
  if (before.role !== after.role) notes.push(`role ${before.role} → ${after.role}`);
  if (before.userId !== after.userId) notes.push(after.userId ? "linked to an admin account" : "unlinked from its account");
  if (before.chatEnabled !== after.chatEnabled) notes.push(after.chatEnabled ? "added to chat support" : "removed from chat support");
  if (before.availability !== after.availability) notes.push(`availability ${after.availability}`);
  if (before.active !== after.active) notes.push(after.active ? "reactivated" : "deactivated");
  return notes.join("; ");
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { id } = await context.params;
  const before = findAgent(id);
  if (!before) return jsonError("NOT_FOUND", "No such support member.");
  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  const parsed = readAgentInput(body);
  if (!parsed.ok) return jsonError("VALIDATION_ERROR", parsed.message);
  try {
    const after = updateAgent(id, parsed.input);
    const detail = describe(before, after);
    // An admin flipping their own availability is routine, not an audit event.
    const onlyOwnAvailability =
      Object.keys(parsed.input).length === 1 && parsed.input.availability !== undefined && before.userId === guard.admin.id;
    if (detail && !onlyOwnAvailability) {
      recordAdminAction({
        admin: { id: guard.admin.id, email: guard.admin.email },
        action: "support.member_updated",
        targetType: "support",
        targetId: id,
        targetLabel: after.displayName,
        detail,
      });
    }
    return jsonOk({ agent: after });
  } catch (error) {
    if (error instanceof AgentError) return jsonError("VALIDATION_ERROR", error.message);
    return jsonServerError("admin/support-team/patch", error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { id } = await context.params;
  const before = findAgent(id);
  if (!before) return jsonError("NOT_FOUND", "No such support member.");
  try {
    const result = deleteAgent(id);
    if (!result.ok) return jsonError("CONFLICT", result.reason);
    recordAdminAction({
      admin: { id: guard.admin.id, email: guard.admin.email },
      action: "support.member_deleted",
      targetType: "support",
      targetId: id,
      targetLabel: before.displayName,
      detail: null,
    });
    return jsonOk({});
  } catch (error) {
    return jsonServerError("admin/support-team/delete", error);
  }
}
