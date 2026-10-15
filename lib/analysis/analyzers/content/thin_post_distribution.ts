import type { AnalyzerDef } from "../contract";
import { contentPagesOf, looksLikePost, mainContent, pct, wordCount } from "../util";

/**
 * Of the articles we read, how many are under 300 words of main content.
 *
 * Posts are recognised by article markup (og:type article, a dated
 * <article>) or a blog-style or dated URL. When no page looks like a post,
 * the content pages other than the homepage are used instead, and the
 * result says so. It is a sample of the pages this scan read, not a full
 * count of the site.
 */

const THIN = 300;

export const analyzer: AnalyzerDef = {
  key: "thin_post_distribution",
  name: "Thin post distribution",
  category: "content",
  defaultPlan: "basic",
  scope: "site",
  weight: 4,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const site = ctx.siteMeta;
    const content = contentPagesOf(ctx.crawledPages, site);
    let posts = content.filter(looksLikePost);
    let basis = "posts";
    if (posts.length === 0) {
      posts = content.filter((page) => page.finalUrl !== site.home.finalUrl);
      basis = "content pages (no page was recognisable as a post)";
    }
    if (posts.length === 0) {
      return { status: "warn", findings: [], recommendation: "", confidence: "low", summary: "We did not read any articles to measure." };
    }
    const measured = posts.map((page) => ({ url: page.finalUrl, words: wordCount(mainContent(page.$())) }));
    const thin = measured.filter((m) => m.words < THIN);
    const share = thin.length / measured.length;
    const status = share > 0.5 ? "fail" : share >= 0.2 ? "warn" : "pass";
    return {
      status,
      score: Math.round((1 - share) * 100),
      confidence: measured.length >= 3 ? "medium" : "low",
      summary: `${thin.length} of ${measured.length} ${basis} we read (${pct(share)}) have under ${THIN} words.`,
      findings: thin.slice(0, 10).map((m) => ({ message: `${m.words} words of main content.`, pageUrl: m.url })),
      recommendation: status === "pass" ? "" : `Expand short posts past ${THIN} words with genuinely useful detail, or combine related short posts into one complete article.`,
      features: { thin_share: Number(share.toFixed(3)), posts_measured: measured.length },
    };
  },
};
