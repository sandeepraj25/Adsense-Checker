/**
 * Turning what a person typed into something we can actually fetch.
 *
 * People paste all of these and mean the same site:
 *
 *     example.com          example.com/blog/post
 *     www.example.com      HTTP://Example.com
 *     https://example.com  https://example.com:443/?utm_source=x
 *
 * So: normalise generously, then validate strictly. The two jobs are kept
 * apart because being strict about input *shape* is what rejects real
 * customers' domains, while being strict about the *resolved target* is
 * what keeps the crawler from being used as an SSRF proxy. Only the
 * second kind of strictness belongs in a security decision.
 *
 * `host` is what we dial. `domain` is the apex with any leading "www."
 * removed, used to group reports so www.example.com and example.com are
 * one site in the dashboard rather than two against the site limit.
 */

const HOST_SHAPE =
  /^(?=.{1,253}$)([a-z0-9¡-￿]([a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+[a-z¡-￿]{2,63}$/;

export type Target = {
  /** Absolute URL to fetch, with a scheme and a path. */
  url: URL;
  /** Hostname as submitted, punycoded. What DNS is asked about. */
  host: string;
  /** Grouping key: `host` minus a leading "www.". */
  domain: string;
  /** True when the person typed a scheme themselves. */
  explicitScheme: boolean;
};

export type TargetError =
  | "empty"
  | "scheme"
  | "credentials"
  | "port"
  | "shape"
  | "ip_literal";

export function parseTarget(raw: string): { ok: true; target: Target } | { ok: false; reason: TargetError } {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "empty" };

  // A bare "example.com" is not a URL; "example.com:8080" parses as a URL
  // with scheme "example.com", which is why the scheme test is anchored.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const candidate = hasScheme ? input : `https://${input}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "shape" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials" };
  }
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) {
    return { ok: false, reason: "port" };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "shape" };

  // An IP literal has no site identity — no certificate name, no
  // canonical domain to report on — and is the shape an SSRF attempt
  // takes. Refuse it here and the guard below never has to argue.
  if (/^\[|^[0-9.]+$/.test(host)) {
    return { ok: false, reason: "ip_literal" };
  }
  if (!HOST_SHAPE.test(host)) {
    return { ok: false, reason: "shape" };
  }

  url.hostname = host;
  url.username = "";
  url.password = "";
  url.hash = "";
  if (!url.pathname) url.pathname = "/";

  return {
    ok: true,
    target: {
      url,
      host,
      domain: host.replace(/^www\./, ""),
      explicitScheme: hasScheme,
    },
  };
}

/** A sentence to show the person, per failure reason. */
export function describeTargetError(reason: TargetError): string {
  switch (reason) {
    case "empty":
      return "Enter a website address to analyse.";
    case "scheme":
      return "Only http and https addresses can be analysed.";
    case "credentials":
      return "Remove the username and password from the address.";
    case "port":
      return "Only the standard web ports (80, 443, 8080, 8443) can be analysed.";
    case "ip_literal":
      return "Enter a domain name rather than an IP address — a site is identified by its domain.";
    case "shape":
    default:
      return "That does not look like a website address. Try something like yourdomain.com.";
  }
}

/**
 * Both spellings of the same site, apex first, for a fallback attempt.
 *
 * Plenty of sites answer on exactly one of the two: an apex with no A
 * record, or a www host that was never configured. Trying the other
 * spelling before declaring a site unreachable removes the single most
 * common false negative, and costs one request.
 */
export function hostAlternatives(host: string): string[] {
  if (host.startsWith("www.")) {
    const apex = host.slice(4);
    return apex.includes(".") ? [host, apex] : [host];
  }
  return [host, `www.${host}`];
}
