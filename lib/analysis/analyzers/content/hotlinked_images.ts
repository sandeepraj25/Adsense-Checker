import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost, pct } from "../util";

/**
 * Where a page's images are served from, and whether their file names
 * come straight from a stock library.
 *
 * "Hosted elsewhere" is what we can measure; whether that hosting is
 * permitted is not, so this never calls it theft. Known image CDNs are
 * counted separately (they usually serve the site's own uploads). Stock
 * file names (shutterstock_…, iStock-…) suggest downloaded stock photos,
 * which need a licence and add nothing original.
 */

const CDNS = /(?:^|\.)(?:wp\.com|cloudinary\.com|imgix\.net|cloudfront\.net|akamaized\.net|fastly\.net|bunnycdn\.com|b-cdn\.net|jsdelivr\.net|googleusercontent\.com|ggpht\.com|blogger\.com|bp\.blogspot\.com|cdninstagram\.com|shopify\.com|squarespace-cdn\.com|wixstatic\.com|ytimg\.com)$/i;
const STOCK = /(?:^|[/_-])(?:shutterstock_|istock(?:photo)?[-_]|gettyimages[-_]|depositphotos_|adobestock_|dreamstime_|123rf|bigstock[-_]|stock-photo-)/i;

export const analyzer: AnalyzerDef = {
  key: "hotlinked_images",
  name: "Hotlinked and stock images",
  category: "content",
  defaultPlan: "basic",
  scope: "page",
  weight: 2,
  failPriority: "medium",
  warnPriority: "low",
  run(ctx) {
    const $ = ctx.$;
    const site = ctx.siteMeta.host;
    const sources = $("img")
      .map((_, el) => $(el).attr("src") || $(el).attr("data-src") || ($(el).attr("srcset") ?? "").split(/\s+/)[0] || "")
      .get()
      .filter((src) => src && !src.startsWith("data:"));
    if (sources.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: "No images on this page.", features: { external_image_share: 0, stock_images: 0 } };
    }
    let external = 0;
    let cdn = 0;
    const findings: AnalyzerFinding[] = [];
    const externalHosts = new Set<string>();
    let stock = 0;
    for (const src of sources) {
      const host = hostOf(src, ctx.url);
      if (!isOwnHost(host, site)) {
        if (host && CDNS.test(host)) cdn += 1;
        else if (host) {
          external += 1;
          externalHosts.add(host);
        }
      }
      if (STOCK.test(src)) {
        stock += 1;
        if (stock <= 5) findings.push({ message: "The file name comes from a stock-photo library.", evidence: src.slice(0, 200), pageUrl: ctx.url });
      }
    }
    const share = external / sources.length;
    if (sources.length >= 3 && share > 0.5) {
      findings.unshift({ message: `${pct(share)} of images are hosted on other domains (${[...externalHosts].slice(0, 3).join(", ")}). We can't tell whether that use is permitted.`, pageUrl: ctx.url });
    }
    const features = { external_image_share: Number(share.toFixed(3)), stock_images: stock };
    if (findings.length === 0) {
      return { status: "pass", findings: [], recommendation: "", summary: `${sources.length} image(s): ${sources.length - external - cdn} on the site, ${cdn} on a CDN, ${external} elsewhere.`, features };
    }
    return {
      status: "warn",
      findings,
      recommendation: "Host images on your own site (or your CDN) and prefer your own photos. Use stock images only with a licence, and rename and caption them in context.",
      features,
    };
  },
};
