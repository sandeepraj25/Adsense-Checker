import { randomBytes, randomUUID } from "node:crypto";

/**
 * Prefixed, URL-safe, collision-resistant ids. The prefix makes an id
 * self-describing in logs and in a support conversation.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** Short, shout-able report reference shown in the UI: RPT-8F2K4Q. */
export function newReportRef(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return `RPT-${out}`;
}

export function newUuid(): string {
  return randomUUID();
}
