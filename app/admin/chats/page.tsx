import { ChatInbox } from "@/components/admin/ChatInbox";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { requireAdmin } from "@/lib/auth/guard";
import { agentForUser, inboxCounts, listAgents, listInbox, ROLE_LABEL } from "@/lib/chat/service";
import { replyBlocker } from "@/lib/chat/staff";

export const dynamic = "force-dynamic";

export const metadata = { title: "Live chat — Admin" };

/**
 * The support inbox. The admin layout has required an administrator; the
 * APIs this page calls check again on every request.
 */
export default async function AdminChatsPage() {
  const admin = await requireAdmin();
  const me = agentForUser(admin.id);
  const team = listAgents()
    .filter((agent) => agent.active && agent.chatEnabled)
    .map((agent) => ({ id: agent.id, name: agent.displayName, role: ROLE_LABEL[agent.role] }));

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Live chat"
        lede="Conversations from the chat on your website. Replies reach the customer straight away; anything they send while the inbox is closed waits here."
      />
      <ChatInbox
        initial={{
          items: listInbox("all", me?.id ?? null),
          counts: inboxCounts(me?.id ?? null),
          me: me ? { id: me.id, name: me.displayName, role: me.role, availability: me.availability, online: me.online } : null,
          replyBlocker: replyBlocker(me),
        }}
        team={team}
      />
    </div>
  );
}
