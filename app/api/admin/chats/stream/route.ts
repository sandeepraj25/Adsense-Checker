import { touchAgent } from "@/lib/chat/service";
import { chatEventStream } from "@/lib/chat/sse";
import { requireChatStaff } from "@/lib/chat/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live inbox updates for staff. While an admin has the inbox open, the
 * heartbeat keeps their support profile "seen", which is what the public
 * widget's Online indicator reads.
 */
export async function GET(request: Request) {
  const staff = await requireChatStaff();
  if (!staff.ok) return staff.response;
  const agentId = staff.agent?.id ?? null;
  return chatEventStream(request, {
    accept: () => true,
    onHeartbeat: agentId ? () => touchAgent(agentId) : undefined,
  });
}
