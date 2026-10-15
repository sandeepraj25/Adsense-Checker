import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost, mainContent, textOfSelection, wordCount } from "../util";

/**
 * Health and money pages ("Your Money or Your Life") without the context
 * readers need: a named author, sources, and a disclaimer.
 *
 * A page counts as health or finance when its main text uses at least four
 * different topic terms. It then needs an author (byline or author markup)
 * or a disclaimer; strong promises ("cures", "guaranteed returns") with no
 * disclaimer at all fail. This is a content-quality signal, not a medical,
 * financial or legal judgement of the page.
 */

const HEALTH = ["symptom", "symptoms", "diagnosis", "treatment", "dosage", "dose", "medicine", "medication", "disease", "diabetes", "cancer", "blood pressure", "cholesterol", "infection", "therapy", "doctor", "pregnancy", "weight loss", "supplement", "vitamin", "immune", "cure", "side effects", "prescription"];
const FINANCE = ["invest", "investment", "stocks", "stock market", "mutual fund", "loan", "mortgage", "credit score", "credit card", "interest rate", "tax", "insurance", "crypto", "bitcoin", "trading", "returns", "portfolio", "retirement", "savings", "debt", "forex", "emi"];
const STRONG = /\b(?:cures?\s+(?:cancer|diabetes|all|any)|miracle\s+(?:cure|remedy|pill)|guaranteed\s+(?:returns?|profits?|income|results|weight loss)|100%\s+(?:safe|effective|guaranteed|cure)|risk[- ]free\s+(?:returns?|investment|profits?)|double your money|no side effects)\b/i;
const DISCLAIMER = /disclaimer|not (?:a substitute for )?(?:medical|financial|professional|legal|investment) advice|consult (?:a|your) (?:doctor|physician|healthcare|qualified|financial|licensed)|for (?:informational|educational) purposes only|seek (?:professional|medical) advice|do your own research/i;

function termsIn(text: string, terms: string[]): string[] {
  const lower = ` ${text.toLowerCase()} `;
  return terms.filter((term) => new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`).test(lower));
}

export const analyzer: AnalyzerDef = {
  key: "ymyl_without_disclaimer",
  name: "Health and finance content without disclaimers",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const text = mainContent($);
    const health = termsIn(text, HEALTH);
    const finance = termsIn(text, FINANCE);
    const topic = health.length >= finance.length ? "health" : "finance";
    const terms = topic === "health" ? health : finance;
    if (terms.length < 4 || wordCount(text) < 150) {
      return { status: "pass", findings: [], recommendation: "", summary: "Not a health or finance page.", features: { ymyl: 0 } };
    }

    const full = textOfSelection($("body"));
    const disclaimer = DISCLAIMER.test(full);
    const author =
      $('[rel~="author"], [itemprop="author"], .author, .byline, .post-author, .entry-author, meta[name="author"]').length > 0 ||
      /"author"\s*:/.test($('script[type="application/ld+json"]').text()) ||
      /\b(?:written|reviewed|fact[- ]checked)\s+by\s+[A-Z]/.test(full) ||
      /\bBy\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(full.slice(0, 2000));
    const sources = $("main a[href], article a[href]").filter((_, a) => {
      const host = hostOf($(a).attr("href") ?? "", ctx.url);
      return Boolean(host) && !isOwnHost(host, ctx.siteMeta.host);
    }).length;
    const strong = STRONG.exec(text);

    const findings: AnalyzerFinding[] = [];
    if (strong && !disclaimer) findings.push({ message: `A strong ${topic} claim with no disclaimer: "${strong[0]}".`, evidence: strong[0], pageUrl: ctx.url });
    if (!disclaimer) findings.push({ message: `This ${topic} page has no disclaimer.`, evidence: `Topic terms: ${terms.slice(0, 6).join(", ")}`, pageUrl: ctx.url });
    if (!author) findings.push({ message: `This ${topic} page names no author.`, pageUrl: ctx.url });
    if (sources === 0) findings.push({ message: "The article links to no outside sources.", pageUrl: ctx.url });

    const features = { ymyl: 1, ymyl_disclaimer: disclaimer ? 1 : 0, ymyl_author: author ? 1 : 0, ymyl_sources: sources };
    if (disclaimer && author) {
      return { status: "pass", findings: [], recommendation: "", summary: `A ${topic} page with an author and a disclaimer.`, features };
    }
    return {
      status: strong && !disclaimer ? "fail" : "warn",
      confidence: "medium",
      findings,
      recommendation: `Add the author's name and credentials, cite reliable sources, and include a short disclaimer (for example, "This is not ${topic === "health" ? "medical" : "financial"} advice"). Avoid absolute promises.`,
      features,
    };
  },
};
