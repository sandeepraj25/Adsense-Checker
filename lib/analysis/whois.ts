import { lookup } from "node:dns/promises";
import { connect } from "node:net";

import { one, run } from "@/lib/db";

import { isBlockedAddress, isBlockedHostname, isIpLiteral } from "./net";

/**
 * A minimal WHOIS client (RFC 3912) for one fact: when a domain was
 * registered.
 *
 *   1. Ask whois.iana.org which server handles the domain's TLD ("refer:").
 *   2. Ask that server about the domain, and read its creation date.
 *
 * Plain TCP on port 43 through Node's `net` module — no third-party
 * service, no API key. Every server name is screened like a scanned site
 * (no private, loopback or metadata addresses) and connected to by the
 * address that was checked, so a hostile referral cannot point us inside
 * the network. Answers are capped at 64 KB and 8 seconds, only one query
 * runs at a time with a short gap per server (registries rate-limit), and
 * results are cached in the database: 30 days when found, one day when
 * not. Only the server name, the creation date and a short status are
 * stored — never the raw record, which can carry registrant contact data.
 */

const IANA = "whois.iana.org";
const PORT = 43;
const MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const SERVER_GAP_MS = 1_000;
const DAY = 86_400_000;
const TTL: Record<WhoisStatus, number> = { found: 30 * DAY, no_date: 7 * DAY, not_found: DAY, unsupported: 7 * DAY, error: DAY };

export type WhoisStatus = "found" | "no_date" | "not_found" | "unsupported" | "error";

export type WhoisResult = {
  status: WhoisStatus;
  domain: string;
  server: string | null;
  /** Registration date (ms since epoch) when status is "found". */
  createdOn: number | null;
  /** Short, safe explanation — never raw WHOIS text. */
  detail: string;
  cached: boolean;
};

/* ── test hook ──────────────────────────────────────────────────── */

/**
 * In tests only (NODE_ENV=test), ANALYZER_WHOIS_SERVER="host:port" sends
 * every query to a local mock server and skips address screening.
 * Ignored in any other environment.
 */
function testOverride(): { host: string; port: number } | null {
  if (process.env.NODE_ENV !== "test") return null;
  const raw = process.env.ANALYZER_WHOIS_SERVER?.trim();
  if (!raw) return null;
  const [host, port] = raw.split(":");
  return host && port ? { host, port: Number(port) } : null;
}

function cacheDisabled(): boolean {
  return process.env.NODE_ENV === "test" && process.env.ANALYZER_WHOIS_CACHE === "off";
}

/* ── one query at a time ────────────────────────────────────────── */

let queue: Promise<unknown> = Promise.resolve();
const lastAsked = new Map<string, number>();

function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/** A WHOIS server name we are willing to connect to, resolved to a checked address. Exported for tests. */
export async function resolveServer(name: string): Promise<{ address: string; port: number }> {
  const override = testOverride();
  if (override) return { address: override.host, port: override.port };
  const host = name.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw new Error("invalid server name");
  }
  if (isIpLiteral(host) || isBlockedHostname(host)) throw new Error("server name not allowed");
  const answers = await lookup(host, { all: true });
  if (answers.length === 0) throw new Error("server does not resolve");
  for (const answer of answers) if (isBlockedAddress(answer.address)) throw new Error("server resolves to a private address");
  return { address: answers[0]!.address, port: PORT };
}

/** Sends one query and reads the answer, bounded in time and size. */
async function ask(server: string, query: string, timeoutMs: number): Promise<string> {
  const target = await resolveServer(server);
  const gap = testOverride() ? 0 : SERVER_GAP_MS;
  const wait = (lastAsked.get(server) ?? 0) + gap - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, gap)));
  lastAsked.set(server, Date.now());

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const socket = connect({ host: target.address, port: target.port });
    const timer = setTimeout(() => finish(new Error("timed out")), timeoutMs);
    socket.on("connect", () => socket.write(`${query}\r\n`));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (bytes - MAX_BYTES))));
        finish(null); // enough to read a date; stop reading
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("error", (error) => finish(error));
  });
}

/* ── parsing ────────────────────────────────────────────────────── */

const NOT_FOUND = /^\s*(?:no match|not found|no entries found|no data found|domain not found|status:\s*(?:free|available)|no object found|the queried object does not exist)/im;
const CREATED = /^\s*(?:creation date|created on|created|domain registration date|registration date|registration time|registered on|registered|domain name commencement date|record created|domain create date)\s*\.*\s*:\s*(.+)$/im;
const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** Reads a WHOIS date in the common registry formats; null when unsure. */
export function parseWhoisDate(raw: string): number | null {
  const value = raw.trim().replace(/\s*\(.*\)$/, "");
  let iso: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = value.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s](\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2}|UTC)?)?/i))) {
    const time = m[4] ? m[4] : "00:00:00";
    const zone = !m[5] || /utc/i.test(m[5]) ? "Z" : m[5].length === 5 ? `${m[5].slice(0, 3)}:${m[5].slice(3)}` : m[5];
    iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}T${time.length === 5 ? `${time}:00` : time}${zone}`;
  } else if ((m = value.match(/^(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s](\d{4})/i))) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (month) iso = `${m[3]}-${month}-${m[1]!.padStart(2, "0")}T00:00:00Z`;
  } else if ((m = value.match(/^([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i))) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month) iso = `${m[3]}-${month}-${m[2]!.padStart(2, "0")}T00:00:00Z`;
  } else if ((m = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/))) {
    iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}T00:00:00Z`;
  }
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const year = new Date(time).getUTCFullYear();
  return year >= 1985 && year <= 2100 ? time : null;
}

export function readCreationDate(text: string): number | null {
  const match = CREATED.exec(text);
  return match ? parseWhoisDate(match[1] ?? "") : null;
}

/* ── lookup ─────────────────────────────────────────────────────── */

const serverForTld = new Map<string, string | null>();

function cached(domain: string, now: number): WhoisResult | null {
  if (cacheDisabled()) return null;
  try {
    const row = one<{ server: string | null; created_on: number | null; status: WhoisStatus; detail: string | null; fetched_at: number }>(
      "SELECT server, created_on, status, detail, fetched_at FROM whois_cache WHERE domain = ?",
      [domain],
    );
    if (!row || now - row.fetched_at > TTL[row.status]) return null;
    return { status: row.status, domain, server: row.server, createdOn: row.created_on, detail: row.detail ?? "", cached: true };
  } catch {
    return null; // a missing table (older database in a test) is just a cache miss
  }
}

function remember(result: WhoisResult, now: number): void {
  if (cacheDisabled()) return;
  try {
    run(
      `INSERT INTO whois_cache (domain, server, created_on, status, detail, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET server = excluded.server, created_on = excluded.created_on,
         status = excluded.status, detail = excluded.detail, fetched_at = excluded.fetched_at`,
      [result.domain, result.server, result.createdOn, result.status, result.detail.slice(0, 200), now],
    );
  } catch {
    // Caching is an optimisation; failing to store must not fail the lookup.
  }
}

/**
 * When `domain` was registered, from the registry's WHOIS server.
 * Never throws: every failure is a result with a status and a reason.
 */
export async function whoisLookup(domain: string, options: { budgetMs?: number; now?: number } = {}): Promise<WhoisResult> {
  const now = options.now ?? Date.now();
  const name = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const base = { domain: name, cached: false } as const;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) {
    return { ...base, status: "unsupported", server: null, createdOn: null, detail: "Not a domain name WHOIS can look up." };
  }
  const hit = cached(name, now);
  if (hit) return hit;

  const deadline = Date.now() + Math.max(500, options.budgetMs ?? DEFAULT_TIMEOUT_MS * 2);
  const timeLeft = () => Math.min(DEFAULT_TIMEOUT_MS, deadline - Date.now());
  const tld = name.slice(name.lastIndexOf(".") + 1);

  const result = await serially(async (): Promise<WhoisResult> => {
    let server: string | null = null;
    try {
      if (!serverForTld.has(tld)) {
        if (timeLeft() < 300) return { ...base, status: "error", server: null, createdOn: null, detail: "Out of time before asking the registry." };
        const iana = await ask(IANA, tld, timeLeft());
        const refer = iana.match(/^\s*(?:refer|whois):\s*(\S+)/im)?.[1] ?? null;
        serverForTld.set(tld, refer);
      }
      server = serverForTld.get(tld) ?? null;
      if (!server) {
        return { ...base, status: "unsupported", server: null, createdOn: null, detail: `The .${tld} registry does not publish a WHOIS server.` };
      }
      if (timeLeft() < 300) return { ...base, status: "error", server, createdOn: null, detail: "Out of time before asking the registry." };
      const answer = await ask(server, name, timeLeft());
      const createdOn = readCreationDate(answer);
      if (createdOn !== null) return { ...base, status: "found", server, createdOn, detail: "Creation date from the registry." };
      if (NOT_FOUND.test(answer)) return { ...base, status: "not_found", server, createdOn: null, detail: "The registry has no record of this domain." };
      return { ...base, status: "no_date", server, createdOn: null, detail: "The registry's answer does not include a creation date." };
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 80) : "unknown error";
      return { ...base, status: "error", server, createdOn: null, detail: `WHOIS lookup failed (${reason}).` };
    }
  });
  remember(result, now);
  return result;
}

/** Test helper: forget remembered TLD servers. */
export function resetWhoisMemory(): void {
  serverForTld.clear();
  lastAsked.clear();
}
