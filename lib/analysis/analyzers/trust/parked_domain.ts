import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { excerpt, visibleText, wordCount } from "../util";

/**
 * A parked or for-sale domain: a placeholder page from a registrar or
 * parking service instead of a site. AdSense will not approve one.
 *
 * Strong signals: "this domain is for sale"-type copy, or markup from a
 * known parking provider. Weak signal: almost no text and a page that is
 * mostly sponsored-listing links. Strong → fail; weak alone → warning.
 */

const FOR_SALE = /\b(?:this domain (?:name )?(?:is|may be) for sale|buy this domain|domain (?:name )?for sale|make (?:an|us an) offer on this domain|the domain [\w.-]+ is for sale|inquire about this domain|this domain has been registered|this (?:web)?page is parked|domain (?:is )?parked|parked (?:free|domain)|courtesy of godaddy)\b/i;

const PROVIDERS: Array<{ term: RegExp; name: string }> = [
  { term: /sedoparking|sedo\.com\/(?:search|checkdomain)/i, name: "Sedo parking" },
  { term: /parkingcrew/i, name: "ParkingCrew" },
  { term: /bodis\.com|bodiscdn/i, name: "Bodis" },
  { term: /dan\.com\/(?:buy-domain|lander)|undeveloped\.com/i, name: "Dan.com" },
  { term: /afternic\.com/i, name: "Afternic" },
  { term: /hugedomains\.com/i, name: "HugeDomains" },
  { term: /img1\.wsimg\.com\/parking|parking-lander|godaddy\.com\/domain-?parking/i, name: "GoDaddy parking" },
  { term: /above\.com\/(?:marketplace|parking)/i, name: "Above.com" },
  { term: /window\.park\b|\/park\.js/i, name: "a parking script" },
];

export const analyzer: AnalyzerDef = {
  key: "parked_domain",
  name: "Parked domain",
  category: "trust",
  defaultPlan: "free",
  scope: "site",
  weight: 8,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const page = ctx.siteMeta.home;
    const $ = page.$();
    const text = visibleText($);
    const findings: AnalyzerFinding[] = [];
    let strong = 0;

    const sale = FOR_SALE.exec(text) ?? FOR_SALE.exec($("title").text());
    if (sale) {
      strong += 1;
      findings.push({ message: "The homepage says the domain is for sale or parked.", evidence: excerpt(text, Math.max(0, text.indexOf(sale[0])), sale[0].length, 40), pageUrl: page.finalUrl });
    }
    for (const provider of PROVIDERS) {
      if (provider.term.test(page.html)) {
        strong += 1;
        findings.push({ message: `The homepage contains markup from ${provider.name}, a domain-parking service.`, pageUrl: page.finalUrl });
        break;
      }
    }

    const words = wordCount(text);
    const links = $("a[href]").length;
    const sponsored = $("a").filter((_, el) => /sponsored|related (?:searches|links)/i.test($(el).closest("div, section, ul").text().slice(0, 200))).length;
    const listingPage = words < 120 && links >= 8 && sponsored >= Math.max(4, links / 2);
    if (listingPage) findings.push({ message: "The homepage has almost no text and is mostly sponsored-listing links, the shape of a parking page.", evidence: `${words} words, ${links} links`, pageUrl: page.finalUrl });

    if (strong === 0 && !listingPage) {
      return { status: "pass", findings: [], recommendation: "", summary: "The domain hosts a site, not a parking page.", features: { parked: 0 } };
    }
    return {
      status: strong > 0 ? "fail" : "warn",
      confidence: strong > 0 ? "high" : "low",
      findings,
      recommendation: "Point the domain at your real site (remove the registrar's parking page or for-sale lander) before applying.",
      features: { parked: strong > 0 ? 1 : 0.5 },
    };
  },
};
