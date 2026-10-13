import { requireAdminApi } from "@/lib/auth/guard";
import { updateOwnName } from "@/lib/profile";

export const runtime = "nodejs";

/**
 * The administrator's own profile. Same self-only rules as the customer
 * route, behind the admin gate: 401 without a session, 403 for a
 * non-admin. It never accepts a target id — managing *other* accounts
 * stays in /api/admin/users/[id], unchanged.
 */
export async function POST(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  return updateOwnName(guard.admin, request);
}

export const PATCH = POST;
