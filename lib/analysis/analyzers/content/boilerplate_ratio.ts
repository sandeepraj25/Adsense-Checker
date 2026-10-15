import type { AnalyzerDef } from "../contract";
import { pct, textOfSelection, wordCount } from "../util";

/**
 * How much of each page is the site's template rather than its own text.
 *
 * Every text block (paragraph, list item, heading, cell, menu link, loose
 * header/footer/sidebar text) is compared
 * across the pages read. A block that appears on at least 60% of them
 * (and on two or more) is template — menus, footers, sidebars, banners.
 * The ratio reported is page-specific words ÷ all words.
 */

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, blockquote, figcaption";
/** Also counted: menu links and chrome regions with loose text, which is exactly where templates live. */
const CHROME = "a, nav, header, footer, aside";
const INSIDE_BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, blockquote, figcaption";

export const analyzer: AnalyzerDef = {
  key: "boilerplate_ratio",
  name: "Boilerplate ratio",
  category: "content",
  defaultPlan: "basic",
  scope: "site",
  weight: 3,
  failPriority: "medium",
  warnPriority: "low",
  run(ctx) {
    const pages = ctx.crawledPages.filter((page) => page.ok);
    if (pages.length < 2) {
      return { status: "warn", findings: [], recommendation: "", confidence: "low", summary: "At least two pages are needed to tell template text from page text; we read one." };
    }
    const perPage = pages.map((page) => {
      const $ = page.$();
      const blocks = new Map<string, number>();
      $(`${BLOCKS}, ${CHROME}`).each((_, el) => {
        const node = $(el);
        if (node.closest("script, style, noscript, template").length) return;
        if (node.is("li") && node.find("p").length) return; // counted through its paragraphs
        // A link inside a paragraph or list item is counted with it.
        if (node.is("a") && node.parents(INSIDE_BLOCK).length) return;
        // A chrome region counts only its own loose text (not its blocks or links, counted already).
        let text: string;
        if (node.is("nav, header, footer, aside")) {
          const copy = node.clone();
          copy.find(`${BLOCKS}, a, script, style`).remove();
          text = textOfSelection(copy).toLowerCase();
        } else {
          text = textOfSelection(node).toLowerCase();
        }
        const words = wordCount(text);
        if (words >= 1) blocks.set(text, words);
      });
      return { url: page.finalUrl, blocks };
    });

    const documentFrequency = new Map<string, number>();
    for (const page of perPage) for (const text of page.blocks.keys()) documentFrequency.set(text, (documentFrequency.get(text) ?? 0) + 1);
    const threshold = Math.max(2, Math.ceil(pages.length * 0.6));

    let total = 0;
    let template = 0;
    const worst: Array<{ url: string; share: number }> = [];
    for (const page of perPage) {
      let pageTotal = 0;
      let pageTemplate = 0;
      for (const [text, words] of page.blocks) {
        pageTotal += words;
        if ((documentFrequency.get(text) ?? 0) >= threshold) pageTemplate += words;
      }
      total += pageTotal;
      template += pageTemplate;
      if (pageTotal > 0) worst.push({ url: page.url, share: 1 - pageTemplate / pageTotal });
    }
    if (total === 0) return { status: "warn", findings: [], recommendation: "", confidence: "low", summary: "The pages read carry no text blocks to compare." };

    const specific = 1 - template / total;
    const status = specific >= 0.6 ? "pass" : specific >= 0.4 ? "warn" : "fail";
    worst.sort((a, b) => a.share - b.share);
    return {
      status,
      score: Math.round(specific * 100),
      summary: `${pct(specific)} of the text on the ${pages.length} pages read is page-specific; ${pct(1 - specific)} is repeated template.`,
      findings:
        status === "pass"
          ? []
          : worst.slice(0, 5).filter((w) => w.share < 0.6).map((w) => ({ message: `Only ${pct(w.share)} of this page's text is its own.`, pageUrl: w.url })),
      recommendation: status === "pass" ? "" : "Add substantial page-specific text and trim repeated sidebars, banners and footer copy, so each page is mostly its own content.",
      features: { specific_ratio: Number(specific.toFixed(3)), pages_compared: pages.length },
    };
  },
};
