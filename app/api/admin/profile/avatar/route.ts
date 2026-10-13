import { requireAdminApi } from "@/lib/auth/guard";
import { removeOwnAvatar, uploadOwnAvatar } from "@/lib/profile";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  return uploadOwnAvatar(guard.admin, request);
}

export async function DELETE() {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  return removeOwnAvatar(guard.admin);
}
