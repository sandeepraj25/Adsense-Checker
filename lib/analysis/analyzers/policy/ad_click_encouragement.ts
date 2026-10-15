import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { excerpt, visibleText } from "../util";

/**
 * Wording that asks visitors to click ads. AdSense program policies forbid
 * encouraging clicks ("click the ads", "support us by clicking", "visit
 * our sponsors"), so any match is a fail, reported with the exact phrase.
 * Only visible text is read.
 */

export const PHRASES: RegExp[] = [
  /\b(?:please\s+)?click\s+(?:on\s+)?(?:the|our|my|these|those|an?|some|any)\s+(?:ads?|adverts?|advertisements?|sponsors?|banners?|sponsored links?)\b/i,
  /\bsupport\s+(?:us|me|this (?:site|blog|website)|the (?:site|blog))\s+by\s+(?:clicking|visiting\s+(?:our|the)\s+sponsors?)\b/i,
  /\bhelp\s+(?:us|me)\s+(?:out\s+)?by\s+clicking\b/i,
  /\bclick\s+(?:an?\s+)?ads?\s+to\s+(?:support|help)\b/i,
  /\b(?:visit|check out)\s+our\s+sponsors\b/i,
  /\bclicking\s+(?:on\s+)?(?:our|the)\s+ads\s+(?:helps|keeps|supports)\b/i,
];

export const analyzer: AnalyzerDef = {
  key: "ad_click_encouragement",
  name: "Encouraging ad clicks",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 6,
  failPriority: "high",
  run(ctx) {
    const text = visibleText(ctx.$);
    const findings: AnalyzerFinding[] = [];
    for (const phrase of PHRASES) {
      const match = phrase.exec(text);
      if (match) findings.push({ message: `The page asks visitors to click ads: "${match[0]}".`, evidence: excerpt(text, match.index, match[0].length, 50), pageUrl: ctx.url });
    }
    if (findings.length === 0) return { status: "pass", findings: [], recommendation: "", summary: "No wording that asks visitors to click ads.", features: { click_encouragement: 0 } };
    return {
      status: "fail",
      findings,
      recommendation: "Remove every request to click ads or visit sponsors. AdSense does not allow encouraging clicks, even politely.",
      features: { click_encouragement: findings.length },
    };
  },
};
