import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { excerpt, squash, textOfSelection, visibleText, wordCount } from "../util";

/**
 * Visible placeholder copy, and sections that were started but never
 * written: a heading with nothing under it before the next heading.
 */

/**
 * `strong` placeholders are never real copy. The weak ones ("Coming soon")
 * are normal on a full page, so they only fail a page with little else on it.
 */
const PLACEHOLDERS: Array<{ term: RegExp; label: string; strong: boolean }> = [
  { term: /\blorem ipsum\b/i, label: "Lorem ipsum filler text", strong: true },
  { term: /\bdolor sit amet\b/i, label: "Lorem ipsum filler text", strong: true },
  { term: /\b(?:your|insert|add) (?:text|content|title|description) here\b/i, label: "a \"your text here\" placeholder", strong: true },
  { term: /\bplaceholder text\b/i, label: '"Placeholder text"', strong: true },
  { term: /\[(?:placeholder|insert[^\]]*|your [^\]]*)\]/i, label: "a bracketed placeholder", strong: true },
  { term: /\bcoming soon\b/i, label: '"Coming soon"', strong: false },
  { term: /\bunder construction\b/i, label: '"Under construction"', strong: false },
  { term: /\bsample text\b/i, label: '"Sample text"', strong: false },
  { term: /\bTODO:/, label: 'a "TODO" note', strong: false },
];

/** Below this many words of visible text, a weak placeholder is the page. */
const SPARSE_WORDS = 150;

export const analyzer: AnalyzerDef = {
  key: "placeholder_text",
  name: "Placeholder text",
  category: "content",
  defaultPlan: "free",
  scope: "page",
  weight: 4,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const text = visibleText($);
    const findings: AnalyzerFinding[] = [];
    const seen = new Set<string>();
    const sparse = wordCount(text) < SPARSE_WORDS;
    let serious = 0;

    for (const { term, label, strong } of PLACEHOLDERS) {
      const match = term.exec(text);
      if (!match || seen.has(label)) continue;
      seen.add(label);
      if (strong || sparse) serious += 1;
      findings.push({ message: `Visible ${label}.`, evidence: excerpt(text, match.index, match[0].length, 40), pageUrl: ctx.url });
    }

    // Empty sections: an h2/h3 followed by (almost) nothing before the next heading.
    let empty = 0;
    $("h2, h3").each((_, el) => {
      const heading = squash($(el).text());
      if (!heading || $(el).closest("nav, header, footer, aside, form").length) return;
      let words = 0;
      let sibling = $(el).next();
      while (sibling.length && !/^h[1-6]$/i.test(sibling.prop("tagName") ?? "")) {
        if (sibling.is("script, style, noscript")) {
          sibling = sibling.next();
          continue;
        }
        words += wordCount(textOfSelection(sibling)) + sibling.find("img, video, iframe, table").length * 20;
        sibling = sibling.next();
      }
      const isLast = !$(el).nextAll("h1, h2, h3, h4, h5, h6").length;
      if (words < 3 && !(isLast && words > 0)) {
        empty += 1;
        if (empty <= 3) findings.push({ message: `The section "${heading.slice(0, 80)}" has no content under it.`, pageUrl: ctx.url });
      }
    });

    if (findings.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: "No placeholder text or empty sections found.", features: { placeholders: 0, empty_sections: 0 } };
    }
    const filler = findings.length - Math.min(empty, 3);
    return {
      status: serious > 0 ? "fail" : "warn",
      findings,
      recommendation: "Replace every placeholder with real copy and either write or remove empty sections before applying.",
      features: { placeholders: filler, empty_sections: empty },
    };
  },
};
