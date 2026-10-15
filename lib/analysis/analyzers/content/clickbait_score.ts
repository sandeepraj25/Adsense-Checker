import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { squash } from "../util";

/**
 * Clickbait signals in the page's headlines (title, H1–H3, og:title):
 * shouting in capitals, stacked exclamation marks, bait phrases and
 * "number bait". Every signal is listed with the headline it came from.
 *
 * A headline with one exclamation mark or a list number is normal, so a
 * headline needs two or more points to count, and the page fails only
 * when several headlines are clearly bait. It is a signal for review, not
 * a policy verdict.
 */

const BAIT = /\b(?:you won['’]t believe|what happens next|will (?:blow your mind|shock you|leave you speechless)|doctors hate|this one (?:simple )?trick|jaw[- ]dropping|gone wrong|you need to see|nobody (?:is talking about|tells you)|(?:is|are) shaking|the internet is (?:freaking out|losing it)|before it['’]s deleted|number \d+ will)\b/i;
const NUMBER_BAIT = /^\s*\d{1,3}\s+\w+.*\b(?:will (?:shock|surprise|amaze|change)|you (?:won['’]t|didn['’]t) (?:believe|know)|that will make you|which (?:will|one))\b/i;
const ACRONYMS = new Set(["SEO", "HTML", "CSS", "USA", "FAQ", "NASA", "UPI", "GST", "PDF", "API", "DIY", "CEO", "COVID", "AI", "UK", "EU", "NEW", "WIFI", "HTTPS", "URL"]);

export function headlinePoints(headline: string): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;
  const longWords = headline.match(/\b[\p{L}]{4,}\b/gu) ?? [];
  const shouting = longWords.filter((w) => w === w.toUpperCase() && w !== w.toLowerCase() && !ACRONYMS.has(w));
  if (longWords.length >= 3 && shouting.length / longWords.length >= 0.5) {
    points += 1;
    reasons.push("mostly capital letters");
  }
  if (/!{2,}|\?!|!\?|(?:!.*){3,}/.test(headline)) {
    points += 1;
    reasons.push("stacked exclamation marks");
  }
  if (BAIT.test(headline)) {
    points += 2;
    reasons.push("a bait phrase");
  }
  if (NUMBER_BAIT.test(headline)) {
    points += 1;
    reasons.push("number bait");
  }
  return { points, reasons };
}

export const analyzer: AnalyzerDef = {
  key: "clickbait_score",
  name: "Clickbait headlines",
  category: "content",
  defaultPlan: "basic",
  scope: "page",
  weight: 2,
  failPriority: "medium",
  warnPriority: "low",
  run(ctx) {
    const $ = ctx.$;
    const headlines = [...new Set([
      squash($("title").first().text()),
      squash($('meta[property="og:title"]').attr("content") ?? ""),
      ...$("h1, h2, h3").map((_, el) => squash($(el).text())).get(),
    ].filter((h) => h.length >= 8 && h.length <= 300))];

    const findings: AnalyzerFinding[] = [];
    let total = 0;
    for (const headline of headlines) {
      const { points, reasons } = headlinePoints(headline);
      total += points;
      if (points >= 2) findings.push({ message: `Headline reads as clickbait: ${reasons.join(", ")}.`, evidence: headline.slice(0, 160), pageUrl: ctx.url });
    }
    const score = Math.max(0, 100 - total * 12);
    if (findings.length === 0) {
      return { status: "pass", score, findings: [], recommendation: "", summary: `${headlines.length} headline(s) checked; none read as clickbait.`, features: { clickbait_points: total } };
    }
    return {
      status: findings.length >= 3 ? "fail" : "warn",
      score,
      findings,
      recommendation: "Write headlines that say what the article delivers. Drop all-caps, stacked exclamation marks and teaser phrases — AdSense treats misleading headlines as a content-quality problem.",
      features: { clickbait_points: total },
    };
  },
};
