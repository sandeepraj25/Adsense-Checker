import { findUserById } from "@/lib/db/accounts";
import type { AgentInput } from "./service";

/**
 * Reads a support-team form body. Only known fields are taken, each is
 * type-checked, and a linked account must be an existing, unblocked
 * administrator — linking never grants panel access to anyone.
 */
export function readAgentInput(body: Record<string, unknown>): { ok: true; input: AgentInput } | { ok: false; message: string } {
  const input: AgentInput = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") return { ok: false, message: "A display name is text." };
    input.displayName = body.displayName;
  }
  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "member") return { ok: false, message: "Role must be Admin or Member." };
    input.role = body.role;
  }
  for (const key of ["chatEnabled", "active"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") return { ok: false, message: `${key} must be true or false.` };
      input[key] = body[key] as boolean;
    }
  }
  if (body.availability !== undefined) {
    if (body.availability !== "available" && body.availability !== "away") return { ok: false, message: "Availability must be available or away." };
    input.availability = body.availability;
  }
  if (body.userId !== undefined) {
    if (body.userId === null || body.userId === "") {
      input.userId = null;
    } else if (typeof body.userId === "string") {
      const user = findUserById(body.userId);
      if (!user || !user.isAdmin || user.isBlocked) {
        return { ok: false, message: "Only an active administrator account can be linked — they're the ones who can open the inbox." };
      }
      input.userId = user.id;
    } else {
      return { ok: false, message: "Choose an account to link." };
    }
  }
  return { ok: true, input };
}
