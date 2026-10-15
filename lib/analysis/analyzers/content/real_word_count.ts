import type { AnalyzerDef } from "../contract";
import { contentPagesOf, mainContent, wordCount } from "../util";

/**
 * Words of real content per page: the main text after navigation,
 * header, footer, sidebars, forms, scripts, styles and hidden elements
 * are removed. Template text repeated on every page does not count.
 * Policy pages (privacy, contact…) are left out — they are short by nature.
 */

const GOOD = 600;
const THIN = 300;

export const analyzer: AnalyzerDef = {
  key: "real_word_count",
  name: "Real word count",
  category: "content",
  defaultPlan: "basic",
  scope: "page",
  weight: 5,
  failPriority: "high",
  warnPriority: "medium",
  pages: (pages, site) => contentPagesOf(pages, site),
  run(ctx) {
    const count = wordCount(mainContent(ctx.$));
    const status = count >= GOOD ? "pass" : count >= THIN ? "warn" : "fail";
    return {
      status,
      score: Math.min(100, Math.round((count / GOOD) * 100)),
      summary: `${count} words of main content.`,
      findings: status === "pass" ? [] : [{ message: `Only ${count} words of main content (navigation, sidebars and footer excluded).`, evidence: `${count} words`, pageUrl: ctx.url }],
      recommendation: status === "pass" ? "" : `Expand thin pages to at least ${GOOD} words of original, useful text, or merge them into fuller pages.`,
      features: { words: count },
    };
  },
  combine(results) {
    const counts = results.filter((r) => r.result.status !== "error").map((r) => ({ url: r.page.finalUrl, words: r.result.features?.words ?? 0 }));
    if (counts.length === 0) return { status: "error", findings: [], recommendation: "" };
    const sorted = [...counts].sort((a, b) => a.words - b.words);
    const median = sorted[Math.floor(sorted.length / 2)]!.words;
    const average = Math.round(counts.reduce((sum, c) => sum + c.words, 0) / counts.length);
    const thin = sorted.filter((c) => c.words < THIN);
    const status = median < THIN ? "fail" : thin.length > 0 || median < GOOD ? "warn" : "pass";
    return {
      status,
      score: Math.min(100, Math.round((median / GOOD) * 100)),
      summary: `Content pages average ${average} words of real content (median ${median}) across ${counts.length} page(s); ${thin.length} under ${THIN}.`,
      findings: thin.slice(0, 10).map((c) => ({ message: `${c.words} words of main content.`, pageUrl: c.url })),
      recommendation: status === "pass" ? "" : `Bring your main pages to ${GOOD}+ words of original content. Expand the thinnest pages first.`,
      features: { average_words: average, median_words: median, min_words: sorted[0]!.words, thin_pages: thin.length },
    };
  },
};
