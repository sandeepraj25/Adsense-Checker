import type { CheerioAPI } from "cheerio";

import type { AnalyzerDef } from "../contract";
import { contentPagesOf, looksLikePost, pct, textOfSelection } from "../util";

/**
 * Whether articles say who wrote them, and link to that person's page.
 *
 * A byline is author markup (rel=author, itemprop=author, .author/.byline,
 * a meta author tag, JSON-LD "author") or a visible "By Firstname Lastname"
 * near the top. An author link is a link to /author/…, an about or team
 * page, or rel=author. Measured on the articles this scan read.
 */

const AUTHOR_SELECTOR = '[rel~="author"], [itemprop="author"], .author, .byline, .post-author, .entry-author, .author-name, .vcard';

export function bylineOf($: CheerioAPI): { name: string | null; link: boolean } {
  const marked = $(AUTHOR_SELECTOR).first();
  let name = marked.length ? textOfSelection(marked).slice(0, 60) || null : null;
  name ||= ($('meta[name="author"]').attr("content") ?? "").trim() || null;
  if (!name) {
    const ld = $('script[type="application/ld+json"]').text().match(/"author"\s*:\s*(?:\{[^}]*?"name"\s*:\s*"([^"]{2,60})"|"([^"]{2,60})")/);
    name = ld ? (ld[1] ?? ld[2] ?? null) : null;
  }
  if (!name) {
    const region = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
    const top = textOfSelection(region).slice(0, 1500);
    name = top.match(/\bBy\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,3})/u)?.[1] ?? null;
  }
  const link =
    $('a[rel~="author"], a[href*="/author/"], a[href*="/authors/"], a[href*="/team"], a[href*="/about"]').filter((_, a) => {
      const inByline = $(a).closest(`${AUTHOR_SELECTOR}, header, .entry-meta, .post-meta, article`).length > 0;
      return inByline || /author/i.test($(a).attr("href") ?? "") || /author/i.test($(a).attr("rel") ?? "");
    }).length > 0;
  return { name, link };
}

export const analyzer: AnalyzerDef = {
  key: "author_bylines",
  name: "Author bylines",
  category: "trust",
  defaultPlan: "pro",
  scope: "site",
  weight: 2,
  warnPriority: "medium",
  run(ctx) {
    const content = contentPagesOf(ctx.crawledPages, ctx.siteMeta);
    let articles = content.filter(looksLikePost);
    if (articles.length === 0) articles = content.filter((page) => page.finalUrl !== ctx.siteMeta.home.finalUrl);
    if (articles.length === 0) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: "No articles were read, so bylines were not checked." };
    }
    const results = articles.map((page) => ({ page, ...bylineOf(page.$()) }));
    const withName = results.filter((r) => r.name);
    const withLink = results.filter((r) => r.link);
    const share = withName.length / results.length;
    const features = { byline_share: Number(share.toFixed(3)), author_link_share: Number((withLink.length / results.length).toFixed(3)) };
    if (share >= 0.6) {
      return {
        status: "pass",
        findings: [],
        recommendation: "",
        summary: `${withName.length} of ${results.length} articles name their author${withLink.length ? `, ${withLink.length} link to an author page` : ", though none links to an author page"}.`,
        features,
      };
    }
    return {
      status: "warn",
      findings: results.filter((r) => !r.name).slice(0, 8).map((r) => ({ message: "No author is named.", pageUrl: r.page.finalUrl })),
      recommendation: "Show who wrote each article and link the name to a short author bio. Clear authorship builds trust with readers and reviewers, especially on advice content.",
      summary: `Only ${pct(share)} of the articles read name an author.`,
      features,
    };
  },
};
