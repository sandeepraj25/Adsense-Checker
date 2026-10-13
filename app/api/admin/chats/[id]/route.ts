import { ChatInputError, conversationDetail, updateConversation } from "@/lib/chat/service";
import { requireChatStaff } from "@/lib/chat/staff";
import { recordAdminAction } from "@/lib/db/admin";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One conversation, with its messages. Opening it marks customer messages read. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const staff = await requireChatStaff();
  if (!staff.ok) return staff.response;
  const { id } = await context.params;
  const markRead = new URL(request.url).searchParams.get("read") !== "0";
  const detail = conversationDetail(id, { markRead });
  if (!detail) return jsonError("NOT_FOUND", "That conversation doesn't exist.");
  return jsonOk({ detail });
}

/** Body: { status?: "open" | "resolved", assignedAgentId?: string | null | "me" } */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const staff = await requireChatStaff();
  if (!staff.ok) return staff.response;
  const { id } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const input: { status?: "open" | "resolved"; assignedAgentId?: string | null } = {};
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "resolved") return jsonError("VALIDATION_ERROR", "Status must be open or resolved.");
    input.status = body.status;
  }
  if (body.assignedAgentId !== undefined) {
    if (body.assignedAgentId === "me") {
      if (!staff.agent) return jsonError("VALIDATION_ERROR", "Link your account to a support profile first.");
      input.assignedAgentId = staff.agent.id;
    } else if (body.assignedAgentId === null || typeof body.assignedAgentId === "string") {
      input.assignedAgentId = body.assignedAgentId;
    } else {
      return jsonError("VALIDATION_ERROR", "Choose a support member.");
    }
  }

  try {
    if (!updateConversation(id, input)) return jsonError("NOT_FOUND", "That conversation doesn't exist.");
    if (input.status) {
      recordAdminAction({
        admin: { id: staff.admin.id, email: staff.admin.email },
        action: input.status === "resolved" ? "chat.resolved" : "chat.reopened",
        targetType: "support",
        targetId: id,
        targetLabel: "Chat conversation",
        detail: null,
      });
    }
    return jsonOk({ detail: conversationDetail(id, { markRead: false }) });
  } catch (error) {
    if (error instanceof ChatInputError) return jsonError("VALIDATION_ERROR", error.message);
    return jsonServerError("admin/chats/patch", error);
  }
}
