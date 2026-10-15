import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { excerpt, mainContent, squash, visibleText } from "../util";

/**
 * Default-theme and demo content: the first post, sample page and tagline
 * a fresh WordPress (or theme demo import) ships with.
 *
 * Only visible text counts — a phrase inside a script, a style block, an
 * HTML comment or a hidden element is not something a reviewer sees. A
 * hit inside the page's main content or a heading is a fail; one that
 * only shows up in a menu, sidebar or footer is a warning.
 */

const LEFTOVERS: Array<{ term: RegExp; label: string }> = [
  { term: /\bhello world!/i, label: 'the default "Hello world!" post' },
  { term: /welcome to wordpress\. this is your first post/i, label: "the default first-post text" },
  { term: /\bthis is an example page\b/i, label: "the default Sample Page text" },
  { term: /\bsample page\b/i, label: 'a "Sample Page"' },
  { term: /\bjust another wordpress site\b/i, label: "the default WordPress tagline" },
  { term: /\bjust another [\w-]+ (?:site|weblog|blog)\b/i, label: "a default site tagline" },
  { term: /\ba wordpress commenter\b/i, label: "the default WordPress comment" },
  { term: /\bmr\.? wordpress\b/i, label: "the default WordPress commenter" },
  { term: /\bthis is a demo (?:post|page|store|site)\b/i, label: "theme demo content" },
  { term: /\bdemo content\b/i, label: "theme demo content" },
];

export const analyzer: AnalyzerDef = {
  key: "default_theme_leftovers",
  name: "Default theme leftovers",
  category: "content",
  defaultPlan: "free",
  scope: "page",
  weight: 4,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const main = mainContent($);
    const visible = visibleText($);
    const headings = squash($("h1, h2, h3, title").map((_, el) => $(el).text()).get().join(" | "));
    const findings: AnalyzerFinding[] = [];
    let inContent = false;

    for (const { term, label } of LEFTOVERS) {
      const where = term.exec(main) ? "main" : term.exec(headings) ? "heading" : term.exec(visible) ? "template" : null;
      if (!where) continue;
      if (where !== "template") inContent = true;
      const source = where === "main" ? main : where === "heading" ? headings : visible;
      const match = term.exec(source);
      findings.push({
        message: `The page still shows ${label}${where === "template" ? " in its menu, sidebar or footer" : ""}.`,
        evidence: match ? excerpt(source, match.index, match[0].length, 40) : undefined,
        pageUrl: ctx.url,
      });
    }

    if (findings.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: "No default theme or demo content found.", features: { leftovers: 0 } };
    }
    return {
      status: inContent ? "fail" : "warn",
      findings,
      recommendation:
        "Delete the default post, sample page, demo comments and placeholder tagline (Settings → General in WordPress), and remove demo menu links. Reviewers treat them as a site that is not finished.",
      features: { leftovers: findings.length },
    };
  },
};
