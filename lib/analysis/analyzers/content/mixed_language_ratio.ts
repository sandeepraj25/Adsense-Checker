import type { AnalyzerDef } from "../contract";
import { contentPagesOf, mainContent, pct } from "../util";

/**
 * How much of a page is code-mixed — Hindi written in Latin letters
 * ("Hinglish") mixed with English, or Devanagari and Latin script mixed.
 *
 * This is a heuristic estimate, not a language model: the share of words
 * that come from a list of common romanised Hindi words (excluding words
 * that are also English), or the share of the minority script. Above 20%
 * on a page of 100+ words is a warning: reviewers may not recognise the
 * page as one supported language.
 */

const ROMAN_HINDI = new Set("hai hain nahi nahin nhi kya kyun kyon kyunki aap aapka aapki aapke tum tumhara tumhari hum hamara hamari mera meri mere tera teri tere yeh ye woh wo vo kaise kaisa kaisi kab kahan kitna kitni bahut bahot accha achha acha theek thik sab kuch koi kar karo karna karte karke kariye raha rahi rahe tha thi hoga hogi hota hoti hote mujhe tujhe apna apni apne liye lekin aur bhi sirf abhi phir fir jab tab agar toh ka ki ke ko se mein dekho dekhiye chahiye sakte sakta sakti wala wali wale ghar paisa paise log logon din raat saal baat bolo bata batao samajh jaldi zyada pehle baad saath bina dost yaar bhai didi matlab haan ji isliye waise aise jaise wahan yahan upar neeche andar bahar khana pani dil pyaar zindagi duniya sach jhooth hoon hu ho gaya gayi gaye diya liya kiya".split(" "));

export function mixedShare(text: string): { share: number; kind: "hinglish" | "script" | "none"; words: number } {
  const tokens = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (tokens.length === 0) return { share: 0, kind: "none", words: 0 };
  const deva = tokens.filter((t) => /\p{Script=Devanagari}/u.test(t)).length;
  const latin = tokens.filter((t) => /^[a-z]+$/.test(t));
  const minorityScript = Math.min(deva, latin.length) / tokens.length;
  const hinglish = latin.length > 0 ? latin.filter((t) => ROMAN_HINDI.has(t)).length / latin.length : 0;
  if (minorityScript >= hinglish) return { share: minorityScript, kind: minorityScript > 0 ? "script" : "none", words: tokens.length };
  return { share: hinglish, kind: "hinglish", words: tokens.length };
}

export const analyzer: AnalyzerDef = {
  key: "mixed_language_ratio",
  name: "Mixed-language content",
  category: "content",
  defaultPlan: "pro",
  scope: "page",
  weight: 2,
  warnPriority: "medium",
  pages: (pages, site) => contentPagesOf(pages, site),
  run(ctx) {
    const result = mixedShare(mainContent(ctx.$));
    const features = { mixed_language_share: Number(result.share.toFixed(3)) };
    if (result.words < 100) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: "Not measured: fewer than 100 words of main content.", features };
    }
    if (result.share < 0.2) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `About ${pct(result.share)} code-mixed (heuristic estimate).`, features };
    }
    return {
      status: "warn",
      confidence: "low",
      findings: [{
        message: result.kind === "hinglish"
          ? `About ${pct(result.share)} of the words are Hindi written in Latin letters (Hinglish) — a heuristic estimate.`
          : `About ${pct(result.share)} of the words are in a second script (Devanagari mixed with Latin) — a heuristic estimate.`,
        pageUrl: ctx.url,
      }],
      recommendation: "Write each page in one language — English, or Hindi in Devanagari. Romanised Hindi mixed with English may not be recognised as a supported language.",
      features,
    };
  },
};
