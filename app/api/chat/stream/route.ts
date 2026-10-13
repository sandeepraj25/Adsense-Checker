import { optionalUser } from "@/lib/auth/guard";
import { conversationIdFor, resolveCustomer, touchCustomer } from "@/lib/chat/service";
import { chatEventStream } from "@/lib/chat/sse";
import { jsonError } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live updates for the visitor's own conversation: new replies, read
 * receipts, and support coming online. Only events about *their*
 * conversation (resolved here, server-side) are forwarded.
 */
export async function GET(request: Request) {
  if (!rateLimit(`chat:stream:${clientIp(request)}`, 60, 60_000).ok) {
    return jsonError("RATE_LIMITED", "Too many connections.");
  }
  const user = await optionalUser();
  const customer = await resolveCustomer(user?.id ?? null);
  const conversationId = customer ? conversationIdFor(customer) : null;

  return chatEventStream(request, {
    accept: (event) => event.type === "presence" || (conversationId !== null && event.conversationId === conversationId),
    onHeartbeat: conversationId ? () => touchCustomer(conversationId) : undefined,
  });
}
