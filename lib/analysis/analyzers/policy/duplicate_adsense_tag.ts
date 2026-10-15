import type { AnalyzerDef, AnalyzerFinding } from "../contract";

/**
 * The AdSense loader script included more than once on a page, and
 * publisher IDs that disagree across the site.
 *
 * Counted: <script src=".../pagead/js/adsbygoogle.js"> tags, and the
 * publisher ID from the script's client= parameter, <ins data-ad-client>,
 * <amp-auto-ads data-ad-client> and google_ad_client in inline code. Many
 * <ins> slots sharing one ID is normal and not flagged; other ad networks'
 * scripts are not counted.
 */

const LOADER = /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i;

export function publisherIds(html: string): string[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/(?:client=|data-ad-client=["']|google_ad_client["']?\s*[:=]\s*["'])(ca-pub-\d{10,20}|pub-\d{10,20})/gi)) {
    ids.add(m[1]!.toLowerCase().replace(/^ca-/, ""));
  }
  return [...ids];
}

export const analyzer: AnalyzerDef = {
  key: "duplicate_adsense_tag",
  name: "Duplicate AdSense code",
  category: "policy",
  defaultPlan: "basic",
  scope: "site",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const findings: AnalyzerFinding[] = [];
    const siteIds = new Map<string, string>();
    let duplicatePages = 0;
    let pagesWithCode = 0;

    for (const page of ctx.crawledPages.filter((p) => p.ok)) {
      const $ = page.$();
      const loaders = $("script[src]").filter((_, el) => LOADER.test($(el).attr("src") ?? "")).length;
      const ids = publisherIds(page.html);
      if (loaders > 0 || ids.length > 0) pagesWithCode += 1;
      for (const id of ids) if (!siteIds.has(id)) siteIds.set(id, page.finalUrl);
      if (loaders > 1) {
        duplicatePages += 1;
        findings.push({ message: `The AdSense script is loaded ${loaders} times on this page. It only needs to load once.`, evidence: `${loaders} × adsbygoogle.js`, pageUrl: page.finalUrl });
      }
      if (ids.length > 1) findings.push({ message: `This page uses ${ids.length} different publisher IDs.`, evidence: ids.join(", "), pageUrl: page.finalUrl });
    }

    const features = { adsense_publisher_ids: siteIds.size, adsense_duplicate_pages: duplicatePages };
    if (pagesWithCode === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: "No AdSense code on the pages read yet.", features };
    }
    const conflicting = siteIds.size > 1;
    if (conflicting && !findings.some((f) => f.message.includes("different publisher IDs"))) {
      findings.push({ message: `The site uses ${siteIds.size} different publisher IDs across its pages.`, evidence: [...siteIds.keys()].join(", ") });
    }
    if (findings.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: `AdSense code loads once per page with one publisher ID (${[...siteIds.keys()][0] ?? "none"}).`, features };
    }
    return {
      status: conflicting ? "fail" : "warn",
      findings,
      recommendation: conflicting
        ? "Use only your own publisher ID everywhere: remove leftover code from a previous owner, theme or plugin."
        : "Load adsbygoogle.js once per page (usually in the <head>); keep only the <ins> slots repeated.",
      features,
    };
  },
};
