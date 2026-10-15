import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { ADSENSE_LANGUAGES, ADSENSE_LANGUAGES_VERSION, detectLanguage } from "../../language";
import { contentPagesOf, declaredLanguage, mainContent } from "../util";

/**
 * Whether each page declares its language (<html lang>) and whether the
 * declaration matches the language the text is written in, using the local
 * detector in lib/analysis/language.ts.
 *
 * A confident mismatch, or no declaration, is a warning; a declared
 * language outside our local copy of AdSense's supported list is a
 * warning to check Google's current list. When the detector is not
 * confident (short or mixed text, an unsupported Latin language) it says
 * so and does not judge.
 */

const SAME_FAMILY: Record<string, string[]> = { hi: ["hi", "mr", "ne", "sa"], ar: ["ar", "ur", "fa"], ru: ["ru", "uk", "bg", "sr", "be", "kk"], zh: ["zh", "ja"], id: ["id", "ms"], no: ["no", "nb", "nn"] };

function matches(declared: string, detected: string): boolean {
  if (declared === detected) return true;
  return Object.values(SAME_FAMILY).some((family) => family.includes(declared) && family.includes(detected));
}

export const analyzer: AnalyzerDef = {
  key: "language_check",
  name: "Page language",
  category: "content",
  defaultPlan: "pro",
  scope: "page",
  weight: 2,
  warnPriority: "medium",
  pages: (pages, site) => contentPagesOf(pages, site),
  run(ctx) {
    const declared = declaredLanguage(ctx.$);
    const detected = detectLanguage(mainContent(ctx.$));
    const findings: AnalyzerFinding[] = [];
    const features = { lang_declared: declared ? 1 : 0, lang_mismatch: 0, lang_supported: declared ? (ADSENSE_LANGUAGES.has(declared) ? 1 : 0) : 1 };

    if (!declared) findings.push({ message: `The page does not declare its language (<html lang>)${detected.language !== "unknown" ? `; it reads as ${detected.name}` : ""}.`, pageUrl: ctx.url });
    else if (!ADSENSE_LANGUAGES.has(declared)) findings.push({ message: `The page is declared as "${declared}", which is not in our local list of AdSense-supported languages (${ADSENSE_LANGUAGES_VERSION}); check Google's current list.`, pageUrl: ctx.url });
    if (declared && detected.language !== "unknown" && detected.confidence !== "low" && !matches(declared, detected.language)) {
      features.lang_mismatch = 1;
      findings.push({ message: `The page is declared as "${declared}" but its text reads as ${detected.name} (${detected.confidence} confidence).`, evidence: `<html lang="${ctx.$("html").attr("lang") ?? ""}">`, pageUrl: ctx.url });
    }

    if (findings.length === 0) {
      return {
        status: "pass",
        findings: [],
        recommendation: "",
        confidence: detected.confidence === "low" ? "low" : "high",
        summary: detected.language === "unknown" ? `Declared as "${declared}"; the text was too short or mixed to confirm it.` : `Declared as "${declared}" and written in ${detected.name}.`,
        features,
      };
    }
    return {
      status: "warn",
      confidence: features.lang_mismatch ? detected.confidence : "medium",
      findings,
      recommendation: "Set <html lang> to the language the page is actually written in (for example lang=\"en\" or lang=\"hi\"), and write each page in one supported language.",
      features,
    };
  },
};
