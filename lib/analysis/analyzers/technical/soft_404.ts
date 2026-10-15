import { load } from "cheerio";

import type { AnalyzerDef } from "../contract";
import { containment, mainContent, shingles, visibleText, words } from "../util";
import { fetchMissingPage, missingPageUrl } from "./missing-page";

/**
 * Asks for a page that cannot exist and looks at the answer.
 *
 * A real "not found" is HTTP 404 or 410. A 200 that says "not found" is a
 * soft 404: search engines index the error page as if it were content. A
 * 200 that is simply the homepage again is usually a single-page app or a
 * catch-all redirect — reported as a warning, not a soft 404, because the
 * site may route on the client.
 */

const NOT_FOUND_TEXT = /\b(?:404|not found|page (?:you(?:'re| are) looking for )?(?:doesn['’]t|does not|could not|cannot) (?:exist|be found)|nothing (?:was )?found|no longer (?:exists|available)|page (?:is )?missing)\b/i;

export const analyzer: AnalyzerDef = {
  key: "soft_404",
  name: "Soft 404 pages",
  category: "technical",
  defaultPlan: "free",
  scope: "site",
  weight: 3,
  failPriority: "medium",
  warnPriority: "low",
  async run(ctx) {
    const probeUrl = missingPageUrl(ctx.siteMeta);
    const result = await fetchMissingPage(ctx);
    if (!result) {
      return { status: "warn", findings: [], recommendation: "", confidence: "low", summary: "We could not request a test page, so soft 404s were not checked." };
    }
    const evidence = `GET ${new URL(probeUrl).pathname} → HTTP ${result.status}${result.redirects.length ? ` after ${result.redirects.length} redirect(s) to ${result.finalUrl}` : ""}`;

    if (result.status === 404 || result.status === 410) {
      return { status: "pass", findings: [], recommendation: "", summary: `A page that doesn't exist correctly returns HTTP ${result.status}.`, features: { soft_404: 0 } };
    }
    if (result.status >= 500) {
      return {
        status: "warn",
        findings: [{ message: `A missing page returns a server error (HTTP ${result.status}) instead of 404.`, evidence }],
        recommendation: "Configure the server to answer unknown addresses with HTTP 404 and a helpful not-found page.",
        features: { soft_404: 0.5 },
      };
    }
    if (result.status >= 400) {
      return { status: "pass", findings: [], recommendation: "", summary: `A page that doesn't exist returns HTTP ${result.status}.`, features: { soft_404: 0 } };
    }

    // 2xx (or a 3xx with no Location, which fetch reports as-is).
    const $ = load(result.body);
    const text = visibleText($);
    const homeTokens = shingles(words(mainContent(ctx.siteMeta.home.$())), 5);
    const sameAsHome = containment(shingles(words(mainContent($)), 5), homeTokens) > 0.8 || result.finalUrl.replace(/\/$/, "") === ctx.siteMeta.home.finalUrl.replace(/\/$/, "");

    if (NOT_FOUND_TEXT.test(text) || NOT_FOUND_TEXT.test($("title").text())) {
      return {
        status: "fail",
        findings: [{ message: `A page that doesn't exist answers HTTP ${result.status} while showing "not found" text — a soft 404.`, evidence }],
        recommendation: "Make missing pages return HTTP 404 (or 410). In WordPress this is usually a theme or plugin overriding the 404 status.",
        features: { soft_404: 1 },
      };
    }
    if (sameAsHome) {
      return {
        status: "warn",
        confidence: "medium",
        findings: [{ message: "Any address shows the homepage (HTTP 200). This is normal for some single-page apps, but search engines may index endless duplicate pages.", evidence }],
        recommendation: "Return HTTP 404 for addresses that don't exist, or have the app render a not-found view with a 404 status from the server.",
        features: { soft_404: 0.5 },
      };
    }
    return {
      status: "fail",
      findings: [{ message: `A page that doesn't exist answers HTTP ${result.status} with ordinary content.`, evidence }],
      recommendation: "Make missing pages return HTTP 404 (or 410) so empty addresses are not indexed as content.",
      features: { soft_404: 1 },
    };
  },
};
