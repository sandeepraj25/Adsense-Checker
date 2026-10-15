import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { parseAdsTxtLines } from "../technical/ads_txt_validator";
import { publisherIds } from "./duplicate_adsense_tag";

/**
 * Whether the publisher ID in your AdSense code is the one authorised in
 * ads.txt. Both are normalised to "pub-…" (the code says "ca-pub-…").
 *
 *   fail  the page uses a publisher ID that ads.txt does not list
 *   warn  ads.txt lists Google IDs but no page code uses them, or the
 *         site runs AdSense code with no ads.txt to check against
 *   pass  they match, or there is nothing to compare yet
 */

export const analyzer: AnalyzerDef = {
  key: "pub_id_crosscheck",
  name: "Publisher ID cross-check",
  category: "policy",
  defaultPlan: "pro",
  scope: "site",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  async run(ctx) {
    const pageIds = new Map<string, string>();
    for (const page of ctx.crawledPages.filter((p) => p.ok)) {
      for (const id of publisherIds(page.html)) if (!pageIds.has(id)) pageIds.set(id, page.finalUrl);
    }
    // Same request options as the engine's ads.txt read, so it is shared.
    const file = await ctx.fetchResource(`${ctx.siteMeta.origin}/ads.txt`, { accept: "text/plain", maxBytes: 64 * 1024, timeoutMs: 8_000 });
    const usable = file && file.ok && !/text\/html/i.test(file.contentType) && !/^\s*</.test(file.body.slice(0, 64));
    const listed = new Set(
      usable
        ? parseAdsTxtLines(file.body).flatMap((line) => (line.kind === "record" && line.domain === "google.com" ? [line.account.toLowerCase()] : []))
        : [],
    );
    const features = { pub_ids_in_code: pageIds.size, pub_ids_in_ads_txt: listed.size };

    if (pageIds.size === 0 && listed.size === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: "No AdSense code or Google ads.txt entries yet, so there is nothing to compare.", features };
    }
    const findings: AnalyzerFinding[] = [];
    if (pageIds.size > 0 && listed.size === 0) {
      findings.push({ message: `The site runs AdSense code (${[...pageIds.keys()].join(", ")}) but ads.txt lists no Google publisher ID.`, pageUrl: [...pageIds.values()][0] });
      return { status: "warn", findings, recommendation: "Add the line Google gives you to /ads.txt: google.com, pub-…, DIRECT, f08c47fec0942fa0.", features };
    }
    const missing = [...pageIds].filter(([id]) => !listed.has(id));
    for (const [id, page] of missing) findings.push({ message: `The page code uses ${id}, which ads.txt does not authorise.`, evidence: `ads.txt lists: ${[...listed].join(", ")}`, pageUrl: page });
    if (missing.length > 0) {
      return { status: "fail", findings, recommendation: "Make the publisher ID in your AdSense code and in ads.txt the same — your own. A mismatch usually means leftover code from a theme, plugin or previous owner.", features };
    }
    if (pageIds.size === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: `ads.txt authorises ${[...listed].join(", ")}; no AdSense code on the pages read yet.`, features };
    }
    return { status: "pass", findings: [], recommendation: "", summary: `The publisher ID in the code (${[...pageIds.keys()].join(", ")}) is listed in ads.txt.`, features };
  },
};
