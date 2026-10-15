import type { AnalyzerDef } from "../contract";
import { contentPagesOf, declaredLanguage, englishShare, mainContent, sentences, syllables, words } from "../util";

/**
 * Flesch Reading Ease of each page's main content, computed locally:
 *
 *   206.835 − 1.015 × (words ÷ sentences) − 84.6 × (syllables ÷ words)
 *
 * The formula and its syllable rules are for English. A page that is not
 * declared English and does not read as English is not scored — the
 * number would be meaningless — and says so. Readability is advice, not a
 * policy rule, so this never fails a page; very hard text is a warning.
 */

const MIN_WORDS = 100;

export function fleschReadingEase(text: string): { score: number; words: number; sentences: number } | null {
  const tokens = words(text);
  const count = sentences(text).length;
  if (tokens.length < MIN_WORDS || count === 0) return null;
  const syl = tokens.reduce((sum, w) => sum + syllables(w), 0);
  const score = 206.835 - 1.015 * (tokens.length / count) - 84.6 * (syl / tokens.length);
  return { score: Math.round(Math.max(-50, Math.min(121, score))), words: tokens.length, sentences: count };
}

export const analyzer: AnalyzerDef = {
  key: "readability_score",
  name: "Readability score",
  category: "content",
  defaultPlan: "basic",
  scope: "page",
  weight: 2,
  failPriority: "low",
  warnPriority: "low",
  pages: (pages, site) => contentPagesOf(pages, site),
  run(ctx) {
    const text = mainContent(ctx.$);
    if (words(text).length < MIN_WORDS) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `Not scored: fewer than ${MIN_WORDS} words of main content.` };
    }
    const lang = declaredLanguage(ctx.$);
    const english = lang === "en" || (lang === "" && englishShare(words(text)) >= 0.12);
    if (!english) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `Not scored: Flesch Reading Ease is an English measure and this page is ${lang ? `declared "${lang}"` : "not in English"}.` };
    }
    const result = fleschReadingEase(text);
    if (!result) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `Not scored: fewer than ${MIN_WORDS} words of main content.` };
    }
    const status = result.score >= 50 ? "pass" : "warn";
    return {
      status,
      score: Math.max(0, Math.min(100, result.score)),
      summary: `Flesch Reading Ease ${result.score} (${result.score >= 60 ? "plain English" : result.score >= 50 ? "fairly difficult" : result.score >= 30 ? "difficult" : "very difficult"}).`,
      findings: status === "pass" ? [] : [{ message: `Flesch Reading Ease ${result.score}: long sentences and long words make this hard to read.`, evidence: `${result.words} words in ${result.sentences} sentences`, pageUrl: ctx.url }],
      recommendation: status === "pass" ? "" : "Shorten sentences (aim for under 20 words), prefer common words, and break long paragraphs up.",
      features: { flesch: result.score },
    };
  },
  combine(results) {
    const scored = results.filter((r) => r.result.status !== "error" && typeof r.result.features?.flesch === "number");
    const skipped = results.length - scored.length;
    if (scored.length === 0) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: results[0]?.result.summary ?? "Not scored." };
    }
    const average = Math.round(scored.reduce((sum, r) => sum + (r.result.features?.flesch ?? 0), 0) / scored.length);
    const hard = scored.filter((r) => r.result.status === "warn");
    return {
      status: hard.length > 0 ? "warn" : "pass",
      score: Math.max(0, Math.min(100, average)),
      summary: `Average Flesch Reading Ease ${average} across ${scored.length} page(s)${skipped ? `; ${skipped} not scored (too short or not English)` : ""}.`,
      findings: hard.flatMap((r) => r.result.findings.map((f) => ({ ...f, pageUrl: f.pageUrl ?? r.page.finalUrl }))).slice(0, 10),
      recommendation: hard.length > 0 ? "Shorten sentences (aim for under 20 words), prefer common words, and break long paragraphs up." : "",
      features: { flesch: average },
    };
  },
};
