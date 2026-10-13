import { optionalUser } from "@/lib/auth/guard";
import { customerThread, resolveCustomer, supportStatus } from "@/lib/chat/service";
import { jsonOk, jsonServerError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The visitor's own chat: support status plus their thread, if they have
 * one. Which thread is decided here from the session or the httpOnly chat
 * cookie — the request cannot name one. `?read=1` (sent while the widget
 * is open) marks support replies as read.
 */
export async function GET(request: Request) {
  try {
    const user = await optionalUser();
    const customer = await resolveCustomer(user?.id ?? null);
    const markRead = new URL(request.url).searchParams.get("read") === "1";
    return jsonOk({
      support: supportStatus(),
      thread: customerThread(customer, { markRead }),
      viewer: user ? { name: user.name, signedIn: true } : { name: null, signedIn: false },
    });
  } catch (error) {
    return jsonServerError("chat/get", error);
  }
}
