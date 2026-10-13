import Link from "next/link";

import { SupportTeam, type RosterMember } from "@/components/admin/SupportTeam";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { requireAdmin } from "@/lib/auth/guard";
import { initials, listAdminAccounts, listAgents, repliesByAgent } from "@/lib/chat/service";

export const dynamic = "force-dynamic";

export const metadata = { title: "Support team — Admin" };

/**
 * The names and roles customers see in chat. A member replies from the
 * inbox once linked to an administrator login; the role shown in chat is a
 * label for customers, not a permission.
 */
export default async function SupportTeamPage() {
  const admin = await requireAdmin();
  const accounts = listAdminAccounts();
  const replies = repliesByAgent();
  const byId = new Map(accounts.map((account) => [account.id, account]));

  const members: RosterMember[] = listAgents().map((agent) => {
    const account = agent.userId ? byId.get(agent.userId) : undefined;
    return {
      id: agent.id,
      displayName: agent.displayName,
      initials: initials(agent.displayName),
      role: agent.role,
      userId: agent.userId,
      linkedLabel: account ? account.email : agent.userId ? "an account that is no longer an active admin" : null,
      chatEnabled: agent.chatEnabled,
      availability: agent.availability,
      active: agent.active,
      online: agent.online,
      replies: replies.get(agent.id) ?? 0,
      isMe: agent.userId === admin.id,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Support team"
        lede="The names and roles customers see on chat replies. Link a member to an administrator login so they can reply from Live chat."
      />
      <SupportTeam members={members} accounts={accounts} />
      <p className="text-[0.875rem] leading-relaxed text-cloud-400">
        A member shows as online in the website chat while they have{" "}
        <Link href="/admin/chats" className="font-medium text-azure-600 hover:underline">Live chat</Link> open and are set to Available.
        Members who have replied can be deactivated but not deleted, so past conversations keep their name.
      </p>
    </div>
  );
}
