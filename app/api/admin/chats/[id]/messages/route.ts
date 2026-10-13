import { ChatInputError, sendAgentReply } from "@/lib/chat/service";
import { replyBlocker, requireChatStaff } from "@/lib/chat/staff";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** A support reply, sent under the admin's own support profile. Body: { body, clientId }. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const staff = await requireChatStaff();
  if (!staff.ok) return staff.response;
  const blocked = replyBlocker(staff.agent);
  if (blocked || !staff.agent) return jsonError("FORBIDDEN", blocked ?? "Not allowed.");
  if (!rateLimit(`chat:reply:${staff.admin.id}`, 60, 60_000).ok) {
    return jsonError("RATE_LIMITED", "Slow down a little — too many replies in a minute.");
  }

  const { id } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  try {
    const result = sendAgentReply({ conversationId: id, agent: staff.agent, body: body.body, clientId: body.clientId });
    return jsonOk({ message: result.message, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof ChatInputError) return jsonError("VALIDATION_ERROR", error.message);
    return jsonServerError("admin/chats/reply", error);
  }
}
