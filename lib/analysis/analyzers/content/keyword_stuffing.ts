import type { AnalyzerDef } from "../contract";
import { contentPagesOf, mainContent, pct, words } from "../util";

/**
 * Repeated two- and three-word phrases in a page's main content.
 *
 * Share = occurrences of the phrase ÷ all phrases of that length on the
 * page (tokens − n + 1). A phrase at or above the threshold (3% by
 * default; ANALYZER_KEYWORD_STUFFING_PCT overrides it) and seen at least
 * 4 times is flagged; double the threshold is a fail. Phrases made only
 * of common function words ("of the", "in a") are ignored.
 */

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "is", "it", "this", "that", "as", "be", "are", "was", "you", "your", "we", "our", "i", "my", "from", "if", "so", "but", "not", "can", "will", "do", "have", "has", "they", "their", "its", "into", "than", "then"]);
const MIN_WORDS = 150;

export function stuffingThreshold(): number {
  const raw = Number(process.env.ANALYZER_KEYWORD_STUFFING_PCT);
  return Number.isFinite(raw) && raw > 0 && raw < 50 ? raw / 100 : 0.03;
}

export function topPhrases(tokens: string[], n: number): Array<{ phrase: string; count: number; share: number }> {
  const total = tokens.length - n + 1;
  if (total <= 0) return [];
  const counts = new Map<string, number>();
  for (let i = 0; i < total; i += 1) {
    const gram = tokens.slice(i, i + n);
    if (gram.every((t) => STOP.has(t) || /^\d+$/.test(t))) continue;
    const key = gram.join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([phrase, count]) => ({ phrase, count, share: count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

export const analyzer: AnalyzerDef = {
  key: "keyword_stuffing",
  name: "Keyword stuffing",
  category: "content",
  defaultPlan: "basic",
  scope: "page",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  pages: (pages, site) => contentPagesOf(pages, site),
  run(ctx) {
    const tokens = words(mainContent(ctx.$));
    if (tokens.length < MIN_WORDS) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `Not measured: fewer than ${MIN_WORDS} words of main content.` };
    }
    const threshold = stuffingThreshold();
    const bigrams = topPhrases(tokens, 2);
    const trigrams = topPhrases(tokens, 3);
    const flagged = [...bigrams, ...trigrams].filter((p) => p.share >= threshold && p.count >= 4);
    const maxShare = Math.max(0, ...bigrams.map((p) => p.share), ...trigrams.map((p) => p.share));
    const features = { max_bigram_share: Number((bigrams[0]?.share ?? 0).toFixed(4)), max_trigram_share: Number((trigrams[0]?.share ?? 0).toFixed(4)) };
    if (flagged.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: `No phrase reaches ${pct(threshold)} of the page's phrases (highest ${(maxShare * 100).toFixed(1)}%).`, features };
    }
    return {
      status: flagged.some((p) => p.share >= threshold * 2) ? "fail" : "warn",
      findings: flagged.map((p) => ({
        message: `"${p.phrase}" makes up ${(p.share * 100).toFixed(1)}% of the ${p.phrase.split(" ").length}-word phrases on the page.`,
        evidence: `${p.count} times in ${tokens.length} words`,
        pageUrl: ctx.url,
      })),
      recommendation: "Write naturally: use the phrase where it reads well, and synonyms or pronouns elsewhere. Repetition for search engines reads as spam to reviewers.",
      features,
    };
  },
};
