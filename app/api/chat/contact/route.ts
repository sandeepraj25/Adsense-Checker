import { ChatInputError, setGuestContact } from "@/lib/chat/service";
import { jsonError, jsonOk, jsonServerError, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** A guest's optional name and email, so support can follow up. */
export async function POST(request: Request) {
  if (!rateLimit(`chat:contact:${clientIp(request)}`, 10, 60 * 60_000).ok) {
    return jsonError("RATE_LIMITED", "Try again later.");
  }
  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");
  try {
    return jsonOk({ contact: await setGuestContact(body.name, body.email) });
  } catch (error) {
    if (error instanceof ChatInputError) return jsonError("VALIDATION_ERROR", error.message);
    return jsonServerError("chat/contact", error);
  }
}
