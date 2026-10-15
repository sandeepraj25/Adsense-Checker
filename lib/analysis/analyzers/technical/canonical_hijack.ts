import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost } from "../util";

/**
 * <link rel="canonical"> pointing somewhere unexpected.
 *
 * A canonical on another domain tells Google to index *that* site
 * instead: on the homepage that is a fail (often a hacked theme or a
 * copied template); on other pages a warning, since syndicated articles
 * legitimately point to their original. Inner pages that all point to the
 * homepage, conflicting canonical tags and malformed URLs are warnings.
 */

export const analyzer: AnalyzerDef = {
  key: "canonical_hijack",
  name: "Canonical tags",
  category: "technical",
  defaultPlan: "pro",
  scope: "page",
  weight: 3,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const hrefs = [...new Set($('link[rel~="canonical"]').map((_, el) => ($(el).attr("href") ?? "").trim()).get().filter(Boolean))];
    if (hrefs.length === 0) return { status: "pass", findings: [], recommendation: "", summary: "No canonical tag (Google picks the URL itself).", features: { canonical_external: 0 } };

    const findings: AnalyzerFinding[] = [];
    let external = false;
    const isHome = (() => {
      try {
        return new URL(ctx.url).pathname.replace(/\/+$/, "") === "";
      } catch {
        return false;
      }
    })();
    if (hrefs.length > 1) findings.push({ message: `The page has ${hrefs.length} different canonical tags.`, evidence: hrefs.join(", ").slice(0, 200), pageUrl: ctx.url });
    for (const href of hrefs) {
      let target: URL;
      try {
        target = new URL(href, ctx.url);
      } catch {
        findings.push({ message: "The canonical URL is malformed.", evidence: href.slice(0, 160), pageUrl: ctx.url });
        continue;
      }
      const host = hostOf(target.toString());
      if (host && !isOwnHost(host, ctx.siteMeta.host)) {
        external = true;
        findings.push({ message: `The canonical tag points to another site (${host}).`, evidence: target.toString().slice(0, 160), pageUrl: ctx.url });
      } else if (!isHome && target.pathname.replace(/\/+$/, "") === "") {
        findings.push({ message: "This inner page names the homepage as its canonical, so it may be dropped from search.", evidence: target.toString(), pageUrl: ctx.url });
      }
    }
    const features = { canonical_external: external ? 1 : 0 };
    if (findings.length === 0) return { status: "pass", findings: [], recommendation: "", summary: "The canonical tag points to this site.", features };
    return {
      status: external && isHome ? "fail" : "warn",
      findings,
      recommendation: "Make each page's canonical tag point to its own URL on your domain. A canonical to another domain hands that page's credit to the other site.",
      features,
    };
  },
};
