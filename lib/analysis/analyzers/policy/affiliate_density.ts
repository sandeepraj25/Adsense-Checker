import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { contentPagesOf, mainContent, wordCount } from "../util";

/**
 * Affiliate links per 1,000 words of main content, and whether they are
 * marked rel="sponsored" (or nofollow) as Google asks.
 *
 * Affiliate links are normal; this flags pages that are mostly links to
 * buy things (over 15 per 1,000 words), and unmarked affiliate links.
 * Detection is by well-known affiliate hosts, referral parameters and
 * cloaked /go/ style paths, so some programmes are missed.
 */

const HOSTS = /(?:^|\.)(?:amzn\.to|amzn\.eu|amzn\.in|shareasale\.com|hop\.clickbank\.net|awin1\.com|anrdoezrs\.net|tkqlhce\.com|jdoqocy\.com|dpbolvw\.net|kqzyfj\.com|click\.linksynergy\.com|sjv\.io|fkrt\.it|ekaro\.in|impact\.com|partnerize\.com|prf\.hn|avantlink\.com|go\.skimresources\.com|redirect\.viglink\.com)$/i;
const PARAMS = /[?&](?:tag|ref|aff|affid|aff_id|affiliate|affiliate_id|partner|partnerid|irclickid|clickref|subid|ranmid|ranEAID)=/i;
const PATHS = /\/(?:go|recommends|recommend|out|refer|aff|affiliate|visit|link)\/[^/]+/i;
const MIN_WORDS = 150;

export function isAffiliate(href: string, base: string): boolean {
  try {
    const url = new URL(href, base);
    return HOSTS.test(url.hostname) || PARAMS.test(url.search) || (/amazon\./i.test(url.hostname) && /[?&]tag=/.test(url.search)) || PATHS.test(url.pathname);
  } catch {
    return false;
  }
}

export const analyzer: AnalyzerDef = {
  key: "affiliate_density",
  name: "Affiliate link density",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 2,
  warnPriority: "medium",
  pages: (pages, site) => contentPagesOf(pages, site),
  run(ctx) {
    const $ = ctx.$;
    const words = wordCount(mainContent($));
    const root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
    const links = root.find("a[href]").filter((_, a) => isAffiliate($(a).attr("href") ?? "", ctx.url));
    const count = links.length;
    const unmarked = links.filter((_, a) => !/\b(?:sponsored|nofollow)\b/i.test($(a).attr("rel") ?? "")).length;
    const density = words > 0 ? (count / words) * 1000 : 0;
    const features = { affiliate_links: count, affiliate_per_1000_words: Number(density.toFixed(2)), affiliate_unmarked: unmarked };

    if (count === 0) return { status: "pass", findings: [], recommendation: "", summary: "No affiliate links found.", features };
    const findings: AnalyzerFinding[] = [];
    if (words >= MIN_WORDS && density > 15) {
      findings.push({ message: `${count} affiliate links in ${words} words (${density.toFixed(1)} per 1,000 words).`, pageUrl: ctx.url });
    } else if (words < MIN_WORDS && count >= 5) {
      findings.push({ message: `${count} affiliate links on a page with only ${words} words of content.`, pageUrl: ctx.url });
    }
    if (unmarked >= 3) {
      const sample = links.filter((_, a) => !/\b(?:sponsored|nofollow)\b/i.test($(a).attr("rel") ?? "")).first().attr("href") ?? "";
      findings.push({ message: `${unmarked} affiliate links have no rel="sponsored" or nofollow.`, evidence: sample.slice(0, 120), pageUrl: ctx.url });
    }
    if (findings.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: `${count} affiliate link(s), marked and in proportion (${density.toFixed(1)} per 1,000 words).`, features };
    }
    return {
      status: "warn",
      findings,
      recommendation: "Keep affiliate links in proportion to genuinely useful content, and mark them rel=\"sponsored\". Pages that exist mainly to send visitors to shops are treated as thin affiliate content.",
      features,
    };
  },
};
