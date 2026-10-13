import { endSession } from "@/lib/auth/session";
import { jsonOk } from "@/lib/http";

export const runtime = "nodejs";

export async function POST() {
  await endSession();
  return jsonOk({});
}
