import { AgentError, createAgent, listAgents } from "@/lib/chat/service";
import { readAgentInput } from "@/lib/chat/team-input";
import { requireAdminApi } from "@/lib/auth/guard";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  return jsonOk({ agents: listAgents() });
}

/** Add a member. Body: { displayName, role, userId?, chatEnabled?, availability? } */
export async function POST(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  const parsed = readAgentInput(body);
  if (!parsed.ok) return jsonError("VALIDATION_ERROR", parsed.message);
  if (!parsed.input.displayName) return jsonError("VALIDATION_ERROR", "Give the member a display name.");
  try {
    const agent = createAgent({ ...parsed.input, displayName: parsed.input.displayName, role: parsed.input.role ?? "member" });
    recordAdminAction({
      admin: { id: guard.admin.id, email: guard.admin.email },
      action: "support.member_added",
      targetType: "support",
      targetId: agent.id,
      targetLabel: agent.displayName,
      detail: `role ${agent.role}${agent.userId ? "; linked to an admin account" : ""}`,
    });
    return jsonOk({ agent }, 201);
  } catch (error) {
    if (error instanceof AgentError) return jsonError("VALIDATION_ERROR", error.message);
    return jsonServerError("admin/support-team/post", error);
  }
}
