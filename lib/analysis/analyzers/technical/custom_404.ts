import { load } from "cheerio";

import type { AnalyzerDef } from "../contract";
import { hostOf, isOwnHost, visibleText, wordCount } from "../util";
import { fetchMissingPage, missingPageUrl } from "./missing-page";

/**
 * Whether the "page not found" page helps a lost visitor: links back into
 * the site (navigation, a home link or search) and a sentence of
 * explanation, rather than the web server's bare default error page.
 * Reads the same missing-page response as the Soft 404 check.
 */

const SERVER_DEFAULT = /<center>\s*nginx|Apache(?:\/[\d.]+)?(?: \([^)]*\))? Server at|<h1>Not Found<\/h1>\s*<p>The requested URL|Server Error in '\/' Application|IIS\s+\d|404 - File or directory not found|Error 404 \(Not Found\)!!1|<title>404 Not Found<\/title>\s*<\/head>\s*<body>\s*<h1>/i;

export const analyzer: AnalyzerDef = {
  key: "custom_404",
  name: "Helpful 404 page",
  category: "technical",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  async run(ctx) {
    const result = await fetchMissingPage(ctx);
    if (!result) return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: "Not checked: the test page could not be requested." };
    const path = new URL(missingPageUrl(ctx.siteMeta)).pathname;
    if (result.status >= 200 && result.status < 300) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `Missing pages answer HTTP ${result.status}, so there is no separate 404 page to judge (see Soft 404 pages).` };
    }
    const $ = load(result.body);
    const internal = $("a[href]").filter((_, a) => {
      const host = hostOf($(a).attr("href") ?? "", result.finalUrl);
      return host !== null && isOwnHost(host, ctx.siteMeta.host);
    }).length;
    const search = $("form input[type=search], form input[name=s], form input[name=q]").length > 0;
    const words = wordCount(visibleText($));
    const defaultPage = SERVER_DEFAULT.test(result.body);
    const features = { notfound_internal_links: internal, notfound_words: words, notfound_default_page: defaultPage ? 1 : 0 };
    const evidence = `GET ${path} → HTTP ${result.status}`;

    if (result.status >= 500) {
      return { status: "warn", findings: [{ message: `A missing page causes a server error (HTTP ${result.status}).`, evidence }], recommendation: "Show a friendly not-found page with HTTP 404 instead of an error.", features };
    }
    if (defaultPage || (internal < 2 && !search) || words < 8) {
      return {
        status: "warn",
        findings: [{ message: defaultPage ? "The not-found page is the web server's default error page." : `The not-found page offers no way back into the site (${internal} internal link(s), ${search ? "a" : "no"} search box).`, evidence }],
        recommendation: "Add a custom 404 page with your navigation, a link home, a search box or popular articles, so visitors who hit a dead link stay on the site.",
        features,
      };
    }
    return { status: "pass", findings: [], recommendation: "", summary: `The not-found page (HTTP ${result.status}) links back into the site (${internal} internal link(s)${search ? " and a search box" : ""}).`, features };
  },
};
