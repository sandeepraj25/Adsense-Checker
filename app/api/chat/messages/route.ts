import { optionalUser } from "@/lib/auth/guard";
import { ChatInputError, sendCustomerMessage } from "@/lib/chat/service";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { cookies } from "next/headers";
import { CHAT_COOKIE } from "@/lib/chat/service";

export const runtime = "nodejs";

/**
 * A customer message. Body: { body, clientId } — nothing else is read.
 * `clientId` is a random id the widget makes per message, so a double
 * click or a retried request stores it once.
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  const user = await optionalUser();

  const perIp = rateLimit(`chat:msg:ip:${ip}`, 30, 60_000);
  const perWho = rateLimit(`chat:msg:${user?.id ?? (await cookies()).get(CHAT_COOKIE)?.value ?? ip}`, 20, 60_000);
  if (!perIp.ok || !perWho.ok) {
    return jsonError("RATE_LIMITED", "You're sending messages very quickly. Wait a few seconds and try again.");
  }
  // Starting a brand-new guest conversation has its own, tighter cap.
  if (!user && !(await cookies()).get(CHAT_COOKIE)) {
    const fresh = rateLimit(`chat:new:ip:${ip}`, 5, 60 * 60_000);
    if (!fresh.ok) return jsonError("RATE_LIMITED", "Too many new chats from this connection. Try again later.");
  }

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  try {
    const result = await sendCustomerMessage({ userId: user?.id ?? null, body: body.body, clientId: body.clientId });
    return jsonOk({ message: result.message, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof ChatInputError) return jsonError("VALIDATION_ERROR", error.message);
    return jsonServerError("chat/messages", error);
  }
}
