/**
 * Address classification for the audit fetcher.
 *
 * The analyser fetches whatever URL a signed-in user submits, which
 * makes it a server-side request forgery primitive unless it refuses to
 * talk to anything but the public internet. Cloud metadata endpoints
 * (169.254.169.254), loopback, and RFC1918 space are the interesting
 * targets, so those are the ones enumerated here.
 *
 * Kept free of I/O so it can be exercised directly.
 */

function ipv4Blocked(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0] = octets;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved, incl. 255.255.255.255
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;

  return false;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Expands `::` and returns eight 16-bit groups, or null if malformed. */
function parseIpv6(value: string): number[] | null {
  let text = value.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  // A trailing dotted quad occupies the last two groups.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const suffix = text.slice(lastColon + 1);
  if (suffix.includes(".")) {
    const v4 = parseIpv4(suffix);
    if (!v4) return null;
    tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
    text = text.slice(0, lastColon + 1) + "0";
  }

  const doubleColon = text.indexOf("::");
  let head: string[];
  let rest: string[];
  if (doubleColon === -1) {
    head = text.split(":");
    rest = [];
  } else {
    head = text.slice(0, doubleColon).split(":").filter(Boolean);
    rest = text
      .slice(doubleColon + 2)
      .split(":")
      .filter(Boolean);
  }

  const toGroups = (list: string[]): number[] | null => {
    const out: number[] = [];
    for (const part of list) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  const headGroups = toGroups(head);
  const restGroups = toGroups(rest);
  if (!headGroups || !restGroups) return null;

  if (tail.length === 2) {
    // The placeholder "0" we substituted stands in for the dotted quad.
    if (restGroups.length > 0) restGroups.pop();
    else if (headGroups.length > 0) headGroups.pop();
  }

  const explicit = headGroups.length + restGroups.length + tail.length;
  if (doubleColon === -1) {
    if (explicit !== 8) return null;
    return [...headGroups, ...restGroups, ...tail];
  }
  if (explicit > 8) return null;
  const gap = new Array<number>(8 - explicit).fill(0);
  return [...headGroups, ...gap, ...restGroups, ...tail];
}

/**
 * True when the string is an IP address rather than a hostname.
 *
 * This distinction is load-bearing. `isBlockedAddress` refuses anything
 * it cannot parse, which is right for a DNS answer — an unparseable
 * answer should never be dialled — but catastrophic for a hostname:
 * "example.com" is not an IP, so a blanket "refuse what you cannot
 * parse" rejects the entire public internet. Callers must therefore ask
 * this first and screen hostnames by resolving them instead.
 */
export function isIpLiteral(value: string): boolean {
  let text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  return parseIpv4(text) !== null || parseIpv6(text) !== null;
}

/**
 * True when an address must not be contacted.
 *
 * Expects an IP address: either a literal taken from a URL or an answer
 * returned by DNS. Passing a hostname here is a bug — guard with
 * `isIpLiteral` first.
 */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return ipv4Blocked(v4);

  const g = parseIpv6(ip);
  if (!g) return true; // unparseable: refuse rather than guess

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;

  if (g.every((part) => part === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true; // ::1 loopback
  }

  // ::ffff:0:0/96 — IPv4-mapped. The embedded address is what matters.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return ipv4Blocked([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  // 64:ff9b::/96 — NAT64, and 2002::/16 — 6to4. Both tunnel IPv4.
  if (g0 === 0x0064 && g1 === 0xff9b) {
    return ipv4Blocked([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g0 === 0x2002) {
    return ipv4Blocked([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }

  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
}

/**
 * Hostnames that can never name a public website.
 *
 * Only names that are reserved by specification or by convention for
 * private use are listed. Anything else is treated as potentially public
 * and settled by DNS, because a hostname blocklist that guesses is how
 * you end up rejecting real customers' domains.
 */
const RESERVED_SUFFIXES = [
  ".localhost",
  ".local", // mDNS
  ".internal", // common private convention, reserved by ICANN
  ".intranet",
  ".private",
  ".corp",
  ".home",
  ".lan",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
  ".test", // RFC 2606
  ".invalid", // RFC 2606
  ".example", // RFC 2606
  ".onion", // RFC 7686 — not reachable over plain DNS
  ".alt", // RFC 9476
];

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost") return true;
  if (host === "example.com" || host === "example.net" || host === "example.org") {
    return false; // genuinely resolvable, and useful as a smoke test
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  // A single label with no dot is an intranet name, never a public site.
  if (!host.includes(".")) return true;
  return false;
}
