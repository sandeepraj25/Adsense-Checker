import { requireAdminApi } from "@/lib/auth/guard";
import type { User } from "@/lib/db/types";
import { agentForUser, type SupportAgent } from "./service";

/**
 * The staff side of chat sits behind the existing admin gate — the same
 * check every admin API makes. On top of that, *replying* needs the
 * admin's account to be linked to an active support profile, because the
 * customer sees that profile's name and role on the reply.
 */
export async function requireChatStaff(): Promise<
  | { ok: true; admin: User; agent: SupportAgent | null }
  | { ok: false; response: Response }
> {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard;
  return { ok: true, admin: guard.admin, agent: agentForUser(guard.admin.id) };
}

export function replyBlocker(agent: SupportAgent | null): string | null {
  if (!agent) return "Your account isn't linked to a support-team profile yet. Link it on Admin → Support team to reply.";
  if (!agent.active) return "Your support profile is deactivated. Reactivate it on Admin → Support team to reply.";
  if (!agent.chatEnabled) return "Your support profile is off the chat rota. Turn chat support on for it to reply.";
  return null;
}
