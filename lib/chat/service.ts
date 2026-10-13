import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { many, one, run, tx } from "@/lib/db";
import { authSecret, IS_PROD } from "@/lib/env";
import { newId } from "@/lib/ids";
import { publish } from "./bus";

/**
 * Live chat: conversations, messages, read state and presence.
 *
 * Ownership is the rule everything else hangs on. A customer reaches a
 * conversation in exactly two ways — it carries their account id, or it
 * carries the HMAC of the random token in their httpOnly `aec_chat`
 * cookie. Nothing in a URL or a request body names a conversation on the
 * customer side, so there is no id to guess or swap. Staff reach any
 * conversation, but only through routes that have already required an
 * administrator.
 */

export const CHAT_COOKIE = "aec_chat";
const GUEST_TTL_S = 180 * 24 * 60 * 60;
export const MAX_MESSAGE_LENGTH = 2000;
/** A stream heartbeat refreshes presence every 25s; 70s tolerates one miss. */
export const ONLINE_WINDOW_MS = 70_000;
const HISTORY_LIMIT = 200;

/* ── rows ───────────────────────────────────────────────────────── */

type AgentRow = {
  id: string;
  user_id: string | null;
  display_name: string;
  role: string;
  chat_enabled: number;
  availability: string;
  active: number;
  last_seen_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

type ConversationRow = {
  id: string;
  user_id: string | null;
  guest_token_hash: string | null;
  guest_name: string | null;
  guest_email: string | null;
  status: string;
  assigned_agent_id: string | null;
  created_at: number;
  updated_at: number;
  last_message_at: number;
  last_message_preview: string;
  last_sender: string | null;
  customer_last_read_at: number;
  agent_last_read_at: number;
  customer_last_seen_at: number | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_type: "customer" | "agent";
  agent_id: string | null;
  agent_name: string | null;
  agent_role: string | null;
  body: string;
  client_id: string | null;
  created_at: number;
};

/* ── views ──────────────────────────────────────────────────────── */

export type AgentRole = "admin" | "member";

export type SupportAgent = {
  id: string;
  userId: string | null;
  displayName: string;
  role: AgentRole;
  chatEnabled: boolean;
  availability: "available" | "away";
  active: boolean;
  lastSeenAt: number | null;
  online: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  from: "customer" | "agent";
  body: string;
  createdAt: number;
  /** The support member who sent it — display name and role only. */
  agent: { name: string; role: string } | null;
  /** The other side has opened the conversation since this was sent. */
  seen: boolean;
  clientId: string | null;
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function toAgent(row: AgentRow, now = Date.now()): SupportAgent {
  const role: AgentRole = row.role === "admin" ? "admin" : "member";
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    role,
    chatEnabled: row.chat_enabled === 1,
    availability: row.availability === "away" ? "away" : "available",
    active: row.active === 1,
    lastSeenAt: row.last_seen_at,
    online:
      row.active === 1 &&
      row.chat_enabled === 1 &&
      row.user_id !== null &&
      row.availability !== "away" &&
      row.last_seen_at !== null &&
      now - row.last_seen_at < ONLINE_WINDOW_MS,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const ROLE_LABEL: Record<AgentRole, string> = { admin: "Admin", member: "Member" };

function toMessage(row: MessageRow, conv: ConversationRow, viewer: "customer" | "agent", agents: Map<string, AgentRow>): ChatMessage {
  const agent = row.agent_id ? agents.get(row.agent_id) : undefined;
  const otherReadAt = row.sender_type === "customer" ? conv.agent_last_read_at : conv.customer_last_read_at;
  void viewer;
  return {
    id: row.id,
    from: row.sender_type,
    body: row.body,
    createdAt: row.created_at,
    agent:
      row.sender_type === "agent"
        ? {
            // The current name if the member still exists; the name it was
            // sent under if they were since deleted.
            name: agent?.display_name ?? row.agent_name ?? "Support",
            role: ROLE_LABEL[(agent?.role ?? row.agent_role) === "admin" ? "admin" : "member"],
          }
        : null,
    seen: otherReadAt >= row.created_at,
    clientId: row.client_id,
  };
}

function agentMap(): Map<string, AgentRow> {
  return new Map(many<AgentRow>("SELECT * FROM support_agents").map((row) => [row.id, row]));
}

/* ── support team ───────────────────────────────────────────────── */

export function listAgents(): SupportAgent[] {
  const now = Date.now();
  return many<AgentRow>("SELECT * FROM support_agents ORDER BY active DESC, sort_order ASC, created_at ASC").map((row) =>
    toAgent(row, now),
  );
}

export function findAgent(id: string): SupportAgent | null {
  const row = one<AgentRow>("SELECT * FROM support_agents WHERE id = ?", [id]);
  return row ? toAgent(row) : null;
}

export function agentForUser(userId: string): SupportAgent | null {
  const row = one<AgentRow>("SELECT * FROM support_agents WHERE user_id = ?", [userId]);
  return row ? toAgent(row) : null;
}

/** What the public widget may know: names, roles and who is online. */
export function supportStatus(): {
  online: boolean;
  team: { name: string; role: string; initials: string; online: boolean }[];
} {
  const team = listAgents()
    .filter((agent) => agent.active && agent.chatEnabled)
    .map((agent) => ({
      name: agent.displayName,
      role: ROLE_LABEL[agent.role],
      initials: initials(agent.displayName),
      online: agent.online,
    }));
  return { online: team.some((member) => member.online), team };
}

/** Called by an agent's open inbox stream. Announces a change of state. */
export function touchAgent(agentId: string, now = Date.now()): void {
  const before = findAgent(agentId);
  run("UPDATE support_agents SET last_seen_at = ? WHERE id = ?", [now, agentId]);
  if (before && !before.online && findAgent(agentId)?.online) publish({ type: "presence" });
}

export type AgentInput = {
  displayName?: string;
  role?: AgentRole;
  userId?: string | null;
  chatEnabled?: boolean;
  availability?: "available" | "away";
  active?: boolean;
};

export class AgentError extends Error {}

function validName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (trimmed.length < 1 || trimmed.length > 40) throw new AgentError("A display name needs 1 to 40 characters.");
  return trimmed;
}

/** `userId`, if given, must already be an administrator — checked by the caller. */
export function createAgent(input: Required<Pick<AgentInput, "displayName" | "role">> & AgentInput): SupportAgent {
  const now = Date.now();
  const id = newId("agt");
  const order = (one<{ n: number }>("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM support_agents")?.n ?? 0);
  try {
    run(
      `INSERT INTO support_agents (id, user_id, display_name, role, chat_enabled, availability, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        input.userId ?? null,
        validName(input.displayName),
        input.role === "admin" ? "admin" : "member",
        input.chatEnabled === false ? 0 : 1,
        input.availability === "away" ? "away" : "available",
        order,
        now,
        now,
      ],
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new AgentError("That account is already linked to another support profile.");
    }
    throw error;
  }
  publish({ type: "presence" });
  return findAgent(id)!;
}

export function updateAgent(id: string, input: AgentInput): SupportAgent {
  const current = one<AgentRow>("SELECT * FROM support_agents WHERE id = ?", [id]);
  if (!current) throw new AgentError("No such support member.");
  const next = {
    display_name: input.displayName !== undefined ? validName(input.displayName) : current.display_name,
    role: input.role !== undefined ? (input.role === "admin" ? "admin" : "member") : current.role,
    user_id: input.userId !== undefined ? input.userId : current.user_id,
    chat_enabled: input.chatEnabled !== undefined ? (input.chatEnabled ? 1 : 0) : current.chat_enabled,
    availability: input.availability !== undefined ? (input.availability === "away" ? "away" : "available") : current.availability,
    active: input.active !== undefined ? (input.active ? 1 : 0) : current.active,
  };
  try {
    run(
      `UPDATE support_agents
          SET display_name = ?, role = ?, user_id = ?, chat_enabled = ?, availability = ?, active = ?, updated_at = ?
        WHERE id = ?`,
      [next.display_name, next.role, next.user_id, next.chat_enabled, next.availability, next.active, Date.now(), id],
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) {
      throw new AgentError("That account is already linked to another support profile.");
    }
    throw error;
  }
  // A deactivated member keeps their history but stops owning open chats.
  if (next.active === 0 || next.chat_enabled === 0) {
    run("UPDATE chat_conversations SET assigned_agent_id = NULL WHERE assigned_agent_id = ? AND status = 'open'", [id]);
  }
  publish({ type: "presence" });
  return findAgent(id)!;
}

/**
 * Deleting is only allowed for a member who never replied: their name is
 * part of conversations customers can still read. Anyone who did is
 * deactivated instead, which keeps the history intact.
 */
export function deleteAgent(id: string): { ok: true } | { ok: false; reason: string } {
  const sent = one<{ n: number }>("SELECT COUNT(*) AS n FROM chat_messages WHERE agent_id = ?", [id])?.n ?? 0;
  if (sent > 0) {
    return { ok: false, reason: `This member has sent ${sent} ${sent === 1 ? "reply" : "replies"}. Deactivate them instead so those conversations keep their name.` };
  }
  return tx(() => {
    run("UPDATE chat_conversations SET assigned_agent_id = NULL WHERE assigned_agent_id = ?", [id]);
    const removed = run("DELETE FROM support_agents WHERE id = ?", [id]).changes;
    publish({ type: "presence" });
    return removed ? { ok: true as const } : { ok: false as const, reason: "No such support member." };
  });
}

/** Administrator accounts a support profile can be linked to. */
export function listAdminAccounts(): { id: string; name: string; email: string; linkedAgentId: string | null }[] {
  return many<{ id: string; name: string; email: string; agent_id: string | null }>(
    `SELECT u.id, u.name, u.email, a.id AS agent_id FROM users u
       LEFT JOIN support_agents a ON a.user_id = u.id
      WHERE u.role = 'admin' AND u.status = 'active' ORDER BY u.name`,
  ).map((row) => ({ id: row.id, name: row.name, email: row.email, linkedAgentId: row.agent_id }));
}

/** Messages each member has sent, so the roster can say who may be deleted. */
export function repliesByAgent(): Map<string, number> {
  return new Map(
    many<{ agent_id: string; n: number }>(
      "SELECT agent_id, COUNT(*) AS n FROM chat_messages WHERE agent_id IS NOT NULL GROUP BY agent_id",
    ).map((row) => [row.agent_id, row.n]),
  );
}

/* ── the customer's identity ────────────────────────────────────── */

export type Customer =
  | { kind: "user"; userId: string }
  | { kind: "guest"; tokenHash: string };

function hashGuestToken(token: string): string {
  return createHmac("sha256", authSecret()).update(`chat-guest:v1\0${token}`).digest("hex");
}

async function guestHashFromCookie(): Promise<string | null> {
  const token = (await cookies()).get(CHAT_COOKIE)?.value;
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashGuestToken(token) : null;
}

async function setGuestCookie(token: string | null): Promise<void> {
  (await cookies()).set(CHAT_COOKIE, token ?? "", {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    path: "/",
    maxAge: token ? GUEST_TTL_S : 0,
  });
}

/**
 * Who is asking, from server-held state only. For a signed-in person a
 * guest conversation started in this browser is folded into their
 * account here, so signing in never leaves a second thread behind.
 * Route handlers only (it may set a cookie).
 */
export async function resolveCustomer(userId: string | null): Promise<Customer | null> {
  const guestHash = await guestHashFromCookie();
  if (!userId) return guestHash ? { kind: "guest", tokenHash: guestHash } : null;
  if (guestHash) {
    mergeGuestIntoUser(guestHash, userId);
    await setGuestCookie(null);
  }
  return { kind: "user", userId };
}

/** The guest's browser holds the token *and* the user is signed in: only then. */
function mergeGuestIntoUser(guestHash: string, userId: string): void {
  const merged = tx(() => {
    const guest = one<ConversationRow>(
      "SELECT * FROM chat_conversations WHERE guest_token_hash = ? AND user_id IS NULL",
      [guestHash],
    );
    if (!guest) return null;
    const existing = one<ConversationRow>("SELECT * FROM chat_conversations WHERE user_id = ?", [userId]);
    if (!existing) {
      run(
        "UPDATE chat_conversations SET user_id = ?, guest_token_hash = NULL, updated_at = ? WHERE id = ?",
        [userId, Date.now(), guest.id],
      );
      return guest.id;
    }
    // Both exist: the guest messages join the account's thread, in order.
    run("UPDATE OR IGNORE chat_messages SET conversation_id = ? WHERE conversation_id = ?", [existing.id, guest.id]);
    run("DELETE FROM chat_conversations WHERE id = ?", [guest.id]);
    refreshSummary(existing.id, { reopen: guest.status === "open" });
    return existing.id;
  });
  if (merged) publish({ type: "conversation", conversationId: merged });
}

function conversationFor(customer: Customer): ConversationRow | null {
  return customer.kind === "user"
    ? one<ConversationRow>("SELECT * FROM chat_conversations WHERE user_id = ?", [customer.userId])
    : one<ConversationRow>("SELECT * FROM chat_conversations WHERE guest_token_hash = ? AND user_id IS NULL", [customer.tokenHash]);
}

/** The id of the customer's conversation, for filtering stream events. */
export function conversationIdFor(customer: Customer): string | null {
  return conversationFor(customer)?.id ?? null;
}

function refreshSummary(conversationId: string, options: { reopen?: boolean } = {}): void {
  const last = one<MessageRow>(
    "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    [conversationId],
  );
  run(
    `UPDATE chat_conversations
        SET last_message_at = COALESCE(?, last_message_at), last_message_preview = COALESCE(?, last_message_preview),
            last_sender = COALESCE(?, last_sender), updated_at = ?,
            status = CASE WHEN ? THEN 'open' ELSE status END
      WHERE id = ?`,
    [
      last?.created_at ?? null,
      last ? last.body.slice(0, 140) : null,
      last?.sender_type ?? null,
      Date.now(),
      options.reopen ? 1 : 0,
      conversationId,
    ],
  );
}

/* ── messages ───────────────────────────────────────────────────── */

export class ChatInputError extends Error {}

/** Plain text only: control characters out, whitespace tidied, length capped. */
export function cleanBody(raw: unknown): string {
  if (typeof raw !== "string") throw new ChatInputError("Type a message first.");
  const body = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!body) throw new ChatInputError("Type a message first.");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new ChatInputError(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters. This one is ${body.length}.`);
  }
  return body;
}

export function cleanClientId(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null;
}

/** Later than every earlier message in the thread, so order and read cursors never tie. */
function nextTimestamp(conversationId: string): number {
  const latest = one<{ t: number | null }>("SELECT MAX(created_at) AS t FROM chat_messages WHERE conversation_id = ?", [conversationId])?.t ?? 0;
  return Math.max(Date.now(), latest + 1);
}

function insertMessage(conv: ConversationRow, input: {
  from: "customer" | "agent";
  body: string;
  clientId: string | null;
  agent?: SupportAgent;
}): { row: MessageRow; duplicate: boolean } {
  if (input.clientId) {
    const existing = one<MessageRow>(
      "SELECT * FROM chat_messages WHERE conversation_id = ? AND client_id = ?",
      [conv.id, input.clientId],
    );
    if (existing) return { row: existing, duplicate: true };
  }
  const row: MessageRow = {
    id: newId("msg"),
    conversation_id: conv.id,
    sender_type: input.from,
    agent_id: input.agent?.id ?? null,
    agent_name: input.agent?.displayName ?? null,
    agent_role: input.agent?.role ?? null,
    body: input.body,
    client_id: input.clientId,
    created_at: nextTimestamp(conv.id),
  };
  run(
    `INSERT INTO chat_messages (id, conversation_id, sender_type, agent_id, agent_name, agent_role, body, client_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.conversation_id, row.sender_type, row.agent_id, row.agent_name, row.agent_role, row.body, row.client_id, row.created_at],
  );
  run(
    `UPDATE chat_conversations
        SET last_message_at = ?, last_message_preview = ?, last_sender = ?, updated_at = ?,
            status = CASE WHEN ? = 'customer' THEN 'open' ELSE status END,
            customer_last_read_at = CASE WHEN ? = 'customer' THEN ? ELSE customer_last_read_at END,
            agent_last_read_at = CASE WHEN ? = 'agent' THEN ? ELSE agent_last_read_at END
      WHERE id = ?`,
    [
      row.created_at, row.body.slice(0, 140), row.sender_type, row.created_at,
      row.sender_type,
      row.sender_type, row.created_at,
      row.sender_type, row.created_at,
      conv.id,
    ],
  );
  return { row, duplicate: false };
}

/**
 * A customer's message. Creates their conversation on the first one —
 * not on opening the widget, so browsing never writes a row. A guest gets
 * their cookie here.
 */
export async function sendCustomerMessage(input: {
  userId: string | null;
  body: unknown;
  clientId: unknown;
}): Promise<{ message: ChatMessage; conversationId: string; duplicate: boolean }> {
  const body = cleanBody(input.body);
  const clientId = cleanClientId(input.clientId);
  let customer = await resolveCustomer(input.userId);

  let token: string | null = null;
  if (!customer) {
    token = randomBytes(32).toString("base64url");
    customer = { kind: "guest", tokenHash: hashGuestToken(token) };
  }
  const who = customer;

  const result = tx(() => {
    let conv = conversationFor(who);
    if (!conv) {
      const now = Date.now();
      const id = newId("conv");
      run(
        `INSERT INTO chat_conversations (id, user_id, guest_token_hash, status, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?)`,
        [id, who.kind === "user" ? who.userId : null, who.kind === "guest" ? who.tokenHash : null, now, now, now],
      );
      conv = one<ConversationRow>("SELECT * FROM chat_conversations WHERE id = ?", [id])!;
    }
    const inserted = insertMessage(conv, { from: "customer", body, clientId });
    run("UPDATE chat_conversations SET customer_last_seen_at = ? WHERE id = ?", [Date.now(), conv.id]);
    const fresh = one<ConversationRow>("SELECT * FROM chat_conversations WHERE id = ?", [conv.id])!;
    return { conv: fresh, ...inserted };
  });

  if (token) await setGuestCookie(token);
  if (!result.duplicate) publish({ type: "message", conversationId: result.conv.id, from: "customer" });
  return {
    message: toMessage(result.row, result.conv, "customer", agentMap()),
    conversationId: result.conv.id,
    duplicate: result.duplicate,
  };
}

export type CustomerThread = {
  exists: boolean;
  status: "open" | "resolved" | null;
  messages: ChatMessage[];
  unread: number;
  guest: { name: string | null; email: string | null } | null;
};

/** The customer's own thread — the only one they can ever read. */
export function customerThread(customer: Customer | null, options: { markRead?: boolean } = {}): CustomerThread {
  const conv = customer ? conversationFor(customer) : null;
  if (!conv) return { exists: false, status: null, messages: [], unread: 0, guest: null };

  if (options.markRead) {
    const latest = one<{ t: number | null }>(
      "SELECT MAX(created_at) AS t FROM chat_messages WHERE conversation_id = ? AND sender_type = 'agent'",
      [conv.id],
    )?.t;
    if (latest && latest > conv.customer_last_read_at) {
      run("UPDATE chat_conversations SET customer_last_read_at = ? WHERE id = ?", [latest, conv.id]);
      conv.customer_last_read_at = latest;
      publish({ type: "conversation", conversationId: conv.id });
    }
  }

  const rows = many<MessageRow>(
    `SELECT * FROM (SELECT *, rowid AS r FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, r DESC LIMIT ?)
      ORDER BY created_at ASC, r ASC`,
    [conv.id, HISTORY_LIMIT],
  );
  const agents = agentMap();
  const unread =
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ? AND sender_type = 'agent' AND created_at > ?",
      [conv.id, conv.customer_last_read_at],
    )?.n ?? 0;
  return {
    exists: true,
    status: conv.status === "resolved" ? "resolved" : "open",
    messages: rows.map((row) => toMessage(row, conv, "customer", agents)),
    unread,
    guest: conv.user_id ? null : { name: conv.guest_name, email: conv.guest_email },
  };
}

/** A widget that is open (its stream is connected) marks the customer as present. */
export function touchCustomer(conversationId: string): void {
  run("UPDATE chat_conversations SET customer_last_seen_at = ? WHERE id = ?", [Date.now(), conversationId]);
}

/** Optional contact details a guest may leave so support can follow up. */
export async function setGuestContact(name: unknown, email: unknown): Promise<{ name: string | null; email: string | null }> {
  const hash = await guestHashFromCookie();
  if (!hash) throw new ChatInputError("Send a message first, then add your details.");
  const conv = one<ConversationRow>("SELECT * FROM chat_conversations WHERE guest_token_hash = ? AND user_id IS NULL", [hash]);
  if (!conv) throw new ChatInputError("Send a message first, then add your details.");
  const cleanName = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (cleanEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254)) {
    throw new ChatInputError("That email address doesn't look right.");
  }
  run("UPDATE chat_conversations SET guest_name = ?, guest_email = ?, updated_at = ? WHERE id = ?", [
    cleanName || null,
    cleanEmail || null,
    Date.now(),
    conv.id,
  ]);
  publish({ type: "conversation", conversationId: conv.id });
  return { name: cleanName || null, email: cleanEmail || null };
}

/* ── the staff side ─────────────────────────────────────────────── */

export type InboxFilter = "all" | "unread" | "open" | "mine" | "resolved";

export type InboxItem = {
  id: string;
  customerName: string;
  customerEmail: string | null;
  isGuest: boolean;
  preview: string;
  lastSender: "customer" | "agent" | null;
  lastMessageAt: number;
  unread: number;
  status: "open" | "resolved";
  assignedAgent: { id: string; name: string } | null;
  customerOnline: boolean;
};

type InboxRow = ConversationRow & {
  u_name: string | null;
  u_email: string | null;
  unread: number;
  agent_name: string | null;
};

function guestLabel(conv: ConversationRow): string {
  // A short, readable tag from the random id, so staff can tell guests apart.
  const tag = conv.id.replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase();
  return conv.guest_name ? `${conv.guest_name} (guest)` : `Guest ${tag}`;
}

function toInboxItem(row: InboxRow, now: number): InboxItem {
  return {
    id: row.id,
    customerName: row.user_id ? row.u_name ?? "Deleted account" : guestLabel(row),
    customerEmail: row.user_id ? row.u_email : row.guest_email,
    isGuest: !row.user_id,
    preview: row.last_message_preview,
    lastSender: row.last_sender === "agent" ? "agent" : row.last_sender === "customer" ? "customer" : null,
    lastMessageAt: row.last_message_at,
    unread: row.unread,
    status: row.status === "resolved" ? "resolved" : "open",
    assignedAgent: row.assigned_agent_id ? { id: row.assigned_agent_id, name: row.agent_name ?? "Former member" } : null,
    customerOnline: row.customer_last_seen_at !== null && now - row.customer_last_seen_at < ONLINE_WINDOW_MS,
  };
}

const INBOX_SELECT = `
  SELECT c.*, u.name AS u_name, u.email AS u_email, a.display_name AS agent_name,
         (SELECT COUNT(*) FROM chat_messages m
           WHERE m.conversation_id = c.id AND m.sender_type = 'customer' AND m.created_at > c.agent_last_read_at) AS unread
    FROM chat_conversations c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN support_agents a ON a.id = c.assigned_agent_id`;

export function listInbox(filter: InboxFilter, myAgentId: string | null, search = ""): InboxItem[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter === "open") where.push("c.status = 'open'");
  if (filter === "resolved") where.push("c.status = 'resolved'");
  if (filter === "mine") {
    where.push("c.assigned_agent_id = ?");
    params.push(myAgentId ?? "—none—");
  }
  const term = search.trim().toLowerCase().slice(0, 80);
  if (term) {
    where.push("(LOWER(COALESCE(u.name, c.guest_name, '')) LIKE ? OR LOWER(COALESCE(u.email, c.guest_email, '')) LIKE ? OR LOWER(c.last_message_preview) LIKE ?)");
    const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like);
  }
  let sql = `${INBOX_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  if (term) sql = sql.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'");
  sql += " ORDER BY c.last_message_at DESC LIMIT 200";
  const now = Date.now();
  const items = many<InboxRow>(sql, params).map((row) => toInboxItem(row, now));
  return filter === "unread" ? items.filter((item) => item.unread > 0) : items;
}

export function inboxCounts(myAgentId: string | null): Record<InboxFilter, number> {
  const all = listInbox("all", myAgentId);
  return {
    all: all.length,
    unread: all.filter((item) => item.unread > 0).length,
    open: all.filter((item) => item.status === "open").length,
    mine: myAgentId ? all.filter((item) => item.assignedAgent?.id === myAgentId).length : 0,
    resolved: all.filter((item) => item.status === "resolved").length,
  };
}

export type ConversationDetail = {
  item: InboxItem;
  createdAt: number;
  account: {
    id: string;
    name: string;
    email: string;
    status: string;
    createdAt: number;
    plan: string | null;
  } | null;
  messages: ChatMessage[];
};

export function conversationDetail(id: string, options: { markRead?: boolean } = {}): ConversationDetail | null {
  const row = one<InboxRow>(`${INBOX_SELECT} WHERE c.id = ?`, [id]);
  if (!row) return null;

  if (options.markRead) {
    const latest = one<{ t: number | null }>(
      "SELECT MAX(created_at) AS t FROM chat_messages WHERE conversation_id = ? AND sender_type = 'customer'",
      [id],
    )?.t;
    if (latest && latest > row.agent_last_read_at) {
      run("UPDATE chat_conversations SET agent_last_read_at = ? WHERE id = ?", [latest, id]);
      row.agent_last_read_at = latest;
      row.unread = 0;
      publish({ type: "conversation", conversationId: id });
    }
  }

  const account = row.user_id
    ? one<{ id: string; name: string; email: string; status: string; created_at: number; plan: string | null }>(
        `SELECT u.id, u.name, u.email, u.status, u.created_at,
                (SELECT s.plan_name FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active'
                  ORDER BY s.created_at DESC LIMIT 1) AS plan
           FROM users u WHERE u.id = ?`,
        [row.user_id],
      )
    : null;

  const agents = agentMap();
  const rows = many<MessageRow>(
    `SELECT * FROM (SELECT *, rowid AS r FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, r DESC LIMIT ?)
      ORDER BY created_at ASC, r ASC`,
    [id, HISTORY_LIMIT * 2],
  );
  return {
    item: toInboxItem(row, Date.now()),
    createdAt: row.created_at,
    account: account
      ? { id: account.id, name: account.name, email: account.email, status: account.status, createdAt: account.created_at, plan: account.plan }
      : null,
    messages: rows.map((message) => toMessage(message, row, "agent", agents)),
  };
}

export function sendAgentReply(input: {
  conversationId: string;
  agent: SupportAgent;
  body: unknown;
  clientId: unknown;
}): { message: ChatMessage; duplicate: boolean } {
  const body = cleanBody(input.body);
  const clientId = cleanClientId(input.clientId);
  const result = tx(() => {
    const conv = one<ConversationRow>("SELECT * FROM chat_conversations WHERE id = ?", [input.conversationId]);
    if (!conv) throw new ChatInputError("That conversation no longer exists.");
    const inserted = insertMessage(conv, { from: "agent", body, clientId, agent: input.agent });
    // The first person to answer an unowned chat takes it.
    if (!conv.assigned_agent_id) {
      run("UPDATE chat_conversations SET assigned_agent_id = ? WHERE id = ?", [input.agent.id, conv.id]);
    }
    return { conv: one<ConversationRow>("SELECT * FROM chat_conversations WHERE id = ?", [conv.id])!, ...inserted };
  });
  if (!result.duplicate) publish({ type: "message", conversationId: result.conv.id, from: "agent" });
  return { message: toMessage(result.row, result.conv, "agent", agentMap()), duplicate: result.duplicate };
}

export function updateConversation(
  id: string,
  input: { status?: "open" | "resolved"; assignedAgentId?: string | null },
): boolean {
  const conv = one<ConversationRow>("SELECT * FROM chat_conversations WHERE id = ?", [id]);
  if (!conv) return false;
  if (input.assignedAgentId) {
    const agent = findAgent(input.assignedAgentId);
    if (!agent || !agent.active || !agent.chatEnabled) {
      throw new ChatInputError("Choose an active member of the support team.");
    }
  }
  run(
    "UPDATE chat_conversations SET status = ?, assigned_agent_id = ?, updated_at = ? WHERE id = ?",
    [
      input.status ?? conv.status,
      input.assignedAgentId !== undefined ? input.assignedAgentId : conv.assigned_agent_id,
      Date.now(),
      id,
    ],
  );
  publish({ type: "conversation", conversationId: id });
  return true;
}

/** Total unread customer messages, for the admin sidebar badge. */
export function totalUnreadForStaff(): number {
  return (
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.sender_type = 'customer' AND m.created_at > c.agent_last_read_at`,
    )?.n ?? 0
  );
}
