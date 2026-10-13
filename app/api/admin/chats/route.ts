import { inboxCounts, listInbox, type InboxFilter } from "@/lib/chat/service";
import { replyBlocker, requireChatStaff } from "@/lib/chat/staff";
import { jsonOk, jsonServerError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTERS: InboxFilter[] = ["all", "unread", "open", "mine", "resolved"];

export async function GET(request: Request) {
  const staff = await requireChatStaff();
  if (!staff.ok) return staff.response;
  try {
    const params = new URL(request.url).searchParams;
    const raw = params.get("filter") ?? "all";
    const filter = (FILTERS as string[]).includes(raw) ? (raw as InboxFilter) : "all";
    const me = staff.agent;
    return jsonOk({
      items: listInbox(filter, me?.id ?? null, params.get("q") ?? ""),
      counts: inboxCounts(me?.id ?? null),
      me: me ? { id: me.id, name: me.displayName, role: me.role, availability: me.availability, online: me.online } : null,
      replyBlocker: replyBlocker(me),
    });
  } catch (error) {
    return jsonServerError("admin/chats/list", error);
  }
}
