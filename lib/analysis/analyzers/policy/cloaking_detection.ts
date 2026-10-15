import { load } from "cheerio";

import type { AnalyzerContext, AnalyzerDef, AnalyzerFinding } from "../contract";
import type { FetchResult } from "../../fetcher";
import { hostOf, isOwnHost, mainContent, shingles, wordCount, words } from "../util";

/**
 * Whether Google's crawler is shown a different page than visitors.
 *
 * The homepage and one content page are each fetched twice through the
 * shared crawl — once as Googlebot, once as a desktop Chrome browser —
 * and their main content is compared (three-word sequences, Jaccard
 * similarity), after removing cookie and consent banners. Sending the two
 * to different sites, or Googlebot getting far more text, is reported as
 * possible cloaking; small differences (rotating content, personalisation,
 * A/B tests) are tolerated. A request that fails is "not compared", never
 * evidence of cloaking. Pages are parsed, not rendered.
 */

export const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const OPTIONS = { maxBytes: 1024 * 1024, timeoutMs: 10_000 } as const;

function content(result: FetchResult): string[] {
  const $ = load(result.body);
  $("[class*=cookie], [id*=cookie], [class*=consent], [id*=consent], [class*=gdpr], [class*=banner]").remove();
  return words(mainContent($));
}

export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = shingles(a, 3);
  const sb = shingles(b, 3);
  if (sa.size === 0 || sb.size === 0) {
    const wa = new Set(a);
    const wb = new Set(b);
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared += 1;
    return shared / Math.max(1, new Set([...wa, ...wb]).size);
  }
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

async function compare(ctx: AnalyzerContext, url: string) {
  const [bot, browser] = await Promise.all([
    ctx.fetchResource(url, { ...OPTIONS, userAgent: GOOGLEBOT_UA }),
    ctx.fetchResource(url, { ...OPTIONS, userAgent: BROWSER_UA }),
  ]);
  return { url, bot, browser };
}

export const analyzer: AnalyzerDef = {
  key: "cloaking_detection",
  name: "Cloaking (Googlebot vs visitors)",
  category: "policy",
  defaultPlan: "pro",
  scope: "site",
  weight: 5,
  failPriority: "high",
  warnPriority: "medium",
  timeoutMs: 25_000,
  async run(ctx) {
    const site = ctx.siteMeta;
    const second = ctx.crawledPages.find((page) => page.ok && page.finalUrl !== site.home.finalUrl);
    const targets = [site.home.finalUrl, ...(second ? [second.finalUrl] : [])];
    const results = await Promise.all(targets.map((url) => compare(ctx, url)));

    const findings: AnalyzerFinding[] = [];
    let compared = 0;
    let strong = 0;
    let lowest = 1;
    for (const { url, bot, browser } of results) {
      if (!bot || !browser) continue;
      const botHost = hostOf(bot.finalUrl);
      const browserHost = hostOf(browser.finalUrl);
      if (botHost && browserHost && !isOwnHost(botHost, browserHost) && !isOwnHost(browserHost, botHost)) {
        strong += 1;
        findings.push({ message: "Googlebot and visitors end up on different sites.", evidence: `Googlebot → ${bot.finalUrl}; browser → ${browser.finalUrl}`, pageUrl: url });
        continue;
      }
      if (bot.ok !== browser.ok) {
        findings.push({ message: `Googlebot gets HTTP ${bot.status}, a browser gets HTTP ${browser.status}.`, pageUrl: url });
        continue;
      }
      if (!bot.ok) continue;
      compared += 1;
      const a = content(bot);
      const b = content(browser);
      const score = similarity(a, b);
      lowest = Math.min(lowest, score);
      if (score < 0.5 && Math.max(a.length, b.length) >= 50) {
        const more = a.length > b.length * 2 ? "Googlebot is shown much more text" : b.length > a.length * 2 ? "visitors are shown much more text" : "the text differs";
        if (score < 0.3 && a.length > b.length * 2) strong += 1;
        findings.push({ message: `Possible cloaking: ${more} (${Math.round(score * 100)}% similar).`, evidence: `${wordCount(a.join(" "))} words for Googlebot vs ${wordCount(b.join(" "))} for a browser`, pageUrl: url });
      }
    }

    const features = { cloaking_similarity: Number(lowest.toFixed(3)), cloaking_pages_compared: compared };
    if (findings.length === 0) {
      return compared === 0
        ? { status: "pass", findings: [], recommendation: "", confidence: "low", summary: "Not compared: the pages could not be fetched as both Googlebot and a browser.", features }
        : { status: "pass", findings: [], recommendation: "", summary: `Googlebot and visitors see the same content (${Math.round(lowest * 100)}% similar or more, ${compared} page(s) compared).`, features };
    }
    return {
      status: strong > 0 ? "fail" : "warn",
      confidence: "medium",
      findings,
      recommendation: "Serve Google's crawler the same page visitors see. If the difference comes from a plugin, CDN rule or bot protection, configure it to treat Googlebot like a normal visitor.",
      features,
    };
  },
};
