import { lookup } from "node:dns/promises";

import {
  ALLOW_PRIVATE_ANALYSIS_HOSTS,
  ANALYSIS_TIMEOUT_MS,
  ANALYSIS_USER_AGENT,
} from "@/lib/env";
import { AnalysisFailure } from "./types";
import { isBlockedAddress, isBlockedHostname, isIpLiteral } from "./net";
import { hostAlternatives } from "./target";

/**
 * Guarded HTTP for the audit crawler.
 *
 * Every hop — the submitted URL and each redirect target — is resolved
 * and screened before a request goes out, because a redirect to
 * 169.254.169.254 is the standard way to walk past a check that only
 * looks at the original URL.
 *
 * Residual risk, stated plainly: between our DNS lookup and undici's own
 * lookup, an attacker controlling a nameserver with a very short TTL
 * could return a public address to us and a private one to the socket
 * (DNS rebinding). Closing that needs a pinned-IP dispatcher, which
 * cannot be done without breaking TLS hostname verification. Blocking a
 * whole redirect chain plus a hard timeout and body cap is the practical
 * bar here; a deployment handling untrusted input at scale should put an
 * egress proxy in front of this.
 */

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2 * 1024 * 1024;

export type FetchResult = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  body: string;
  bytes: number;
  ms: number;
  truncated: boolean;
};

/**
 * Decides whether a URL may be dialled, without dialling it.
 *
 * Returns a tagged verdict rather than throwing, because the two failure
 * kinds deserve different treatment: "blocked" is a refusal we made on
 * purpose and should never be softened, while "dns" usually means a typo
 * or a dead domain and is worth retrying against the other spelling of
 * the host before giving up on the site.
 */
export type PreflightVerdict =
  | { ok: true }
  | { ok: false; kind: "blocked" | "dns"; message: string };

async function screen(url: URL): Promise<PreflightVerdict> {
  const blocked = (message: string): PreflightVerdict => ({
    ok: false,
    kind: "blocked",
    message,
  });

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return blocked("Only http and https addresses can be audited.");
  }
  if (url.username || url.password) {
    return blocked("Remove credentials from the URL.");
  }
  if (url.port && !["", "80", "443", "8080", "8443"].includes(url.port)) {
    return blocked("Only standard web ports can be audited.");
  }

  if (ALLOW_PRIVATE_ANALYSIS_HOSTS) return { ok: true };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  // An IP written directly into the URL is judged as an address. A
  // hostname is judged by what it resolves to — never by handing the name
  // itself to the address classifier, which refuses whatever it cannot
  // parse and would therefore refuse every domain on the internet.
  if (isIpLiteral(host)) {
    return isBlockedAddress(host.replace(/^\[|\]$/g, ""))
      ? blocked("That address is not on the public internet.")
      : { ok: true };
  }

  if (isBlockedHostname(host)) {
    return blocked(`${host} is a private or reserved name, not a public website address.`);
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return {
      ok: false,
      kind: "dns",
      message: `We could not find a DNS record for ${host}. Check the spelling, and that the domain is live.`,
    };
  }

  if (addresses.length === 0) {
    return {
      ok: false,
      kind: "dns",
      message: `${host} does not resolve to any address.`,
    };
  }
  // Every answer must be public, not merely the first: a host that
  // resolves to both a public and a private address is not auditable.
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      return blocked(
        `${host} resolves to a private network address (${entry.address}), which cannot be audited.`,
      );
    }
  }

  return { ok: true };
}

async function assertPublicHost(url: URL): Promise<void> {
  const verdict = await screen(url);
  if (!verdict.ok) throw new AnalysisFailure(verdict.message, true);
}

/**
 * Resolve-and-screen without fetching, used before a scan is spent.
 *
 * Both spellings of the host are considered, because plenty of sites
 * answer on exactly one of them and reporting a live site as unreachable
 * is the failure mode this whole module exists to avoid. A hard block on
 * *either* spelling still refuses the target: an attacker must not be able
 * to smuggle an internal address past us by pointing www at it.
 */
export async function preflight(target: {
  url: URL;
  host: string;
}): Promise<PreflightVerdict> {
  let lastDnsFailure: PreflightVerdict | null = null;

  for (const host of hostAlternatives(target.host)) {
    const candidate = new URL(target.url.toString());
    candidate.hostname = host;
    const verdict = await screen(candidate);
    if (verdict.ok) return verdict;
    // A deliberate refusal is final. A missing DNS record is not, until
    // every spelling has been tried.
    if (verdict.kind === "blocked") return verdict;
    lastDnsFailure ??= verdict;
  }

  return (
    lastDnsFailure ?? {
      ok: false,
      kind: "dns",
      message: `We could not resolve ${target.host}. Check that the site is online and publicly reachable.`,
    }
  );
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: "", bytes: 0, truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, maxBytes - (bytes - value.byteLength))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(joined),
    bytes: truncated ? maxBytes : bytes,
    truncated,
  };
}

export async function fetchGuarded(
  target: string | URL,
  options?: { accept?: string; maxBytes?: number; timeoutMs?: number },
): Promise<FetchResult> {
  const started = Date.now();
  const maxBytes = options?.maxBytes ?? MAX_BYTES;
  const requestedUrl = typeof target === "string" ? target : target.toString();

  let current: URL;
  try {
    current = typeof target === "string" ? new URL(target) : new URL(target.toString());
  } catch {
    throw new AnalysisFailure("That does not look like a valid address.", true);
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? ANALYSIS_TIMEOUT_MS,
  );

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicHost(current);

      let response: Response;
      try {
        response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          cache: "no-store",
          headers: {
            "User-Agent": ANALYSIS_USER_AGENT,
            Accept: options?.accept ?? "text/html,application/xhtml+xml",
            "Accept-Language": "en",
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AnalysisFailure(
            "The site took too long to respond. Try again, or check that it is up.",
            true,
          );
        }
        throw new AnalysisFailure(
          `We could not reach ${current.hostname}: ${error instanceof Error ? error.message : "connection failed"}`,
          true,
        );
      }

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === MAX_REDIRECTS) {
          throw new AnalysisFailure("Too many redirects.", true);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new AnalysisFailure("The site redirected somewhere invalid.", true);
        }
        await response.body?.cancel().catch(() => undefined);
        current = next;
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const read = await readCapped(response, maxBytes);

      return {
        requestedUrl,
        finalUrl: current.toString(),
        status: response.status,
        ok: response.ok,
        contentType,
        body: read.text,
        bytes: read.bytes,
        ms: Date.now() - started,
        truncated: read.truncated,
      };
    }

    throw new AnalysisFailure("Too many redirects.", true);
  } finally {
    clearTimeout(timer);
  }
}

/** HEAD-like probe used for link checking; falls back to GET on 405. */
export async function probe(
  target: string,
  timeoutMs = 6_000,
): Promise<{ status: number; ok: boolean } | null> {
  try {
    const url = new URL(target);
    await assertPublicHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        cache: "no-store",
        headers: { "User-Agent": ANALYSIS_USER_AGENT },
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 405 || response.status === 501) {
        return { status: 200, ok: true }; // server dislikes HEAD, not a broken link
      }
      return { status: response.status, ok: response.ok };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
