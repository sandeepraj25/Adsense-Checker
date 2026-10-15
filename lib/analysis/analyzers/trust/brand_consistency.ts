import type { AnalyzerDef } from "../contract";
import { squash } from "../util";
import { registeredDomain } from "./domain_age_whois";

/**
 * Whether the site presents one name: its title, og:site_name, logo text
 * and organisation markup compared with each other and with the domain.
 *
 * Matching is loose — spaces, case and punctuation are ignored, and a
 * name counts if it contains (or is contained in) the domain name or
 * shares a word with it — because sub-brands, abbreviations and new names
 * on an old domain are all legitimate. It only warns when the names
 * disagree with each other *and* with the domain.
 */

const GENERIC = /^(?:home(?:\s*page)?|welcome|index|untitled|blog|my (?:blog|site|website)|new site|logo|site logo|just another .+ site|wordpress|coming soon)$/i;

function norm(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
}

export function brandsMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))) return true;
  const tx = tokens(a);
  return tokens(b).some((t) => tx.includes(t) || (t.length >= 4 && x.includes(t)));
}

export const analyzer: AnalyzerDef = {
  key: "brand_consistency",
  name: "Brand consistency",
  category: "trust",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  run(ctx) {
    const $ = ctx.siteMeta.home.$();
    const domain = registeredDomain(ctx.siteMeta.host);
    const label = domain.split(".")[0] ?? domain;

    const title = squash($("title").first().text());
    const titleParts = title.split(/\s[|–—:·•-]\s/).map((p) => p.trim()).filter(Boolean);
    const names: Array<{ source: string; name: string }> = [];
    const add = (source: string, name: string | undefined) => {
      const value = squash(name ?? "").slice(0, 80);
      // "Home", "Welcome" or "Just another WordPress site" name nothing.
      if (value && value.length >= 2 && !GENERIC.test(value)) names.push({ source, name: value });
    };
    add("og:site_name", $('meta[property="og:site_name"]').attr("content"));
    add("application name", $('meta[name="application-name"]').attr("content"));
    add("logo", $("header img[alt], [class*=logo] img[alt], img[class*=logo][alt], img[id*=logo][alt]").first().attr("alt"));
    add("logo text", $("[class*=logo]:not(:has(img)), .site-title, .navbar-brand").first().text());
    const ld = $('script[type="application/ld+json"]').text().match(/"@type"\s*:\s*"(?:Organization|WebSite)"[^}]*?"name"\s*:\s*"([^"]{2,80})"/);
    add("organisation markup", ld?.[1]);
    if (titleParts.length > 1) add("page title", titleParts[titleParts.length - 1]);
    else add("page title", title);

    if (names.length === 0) {
      return { status: "warn", confidence: "low", findings: [{ message: "The homepage shows no site name we could read (no title, og:site_name or logo text)." }], recommendation: "Give the site a clear name in its title, logo alt text and og:site_name.", features: { brand_names: 0 } };
    }
    const matchesDomain = names.filter((n) => brandsMatch(n.name, label));
    const agree = names.every((n) => brandsMatch(n.name, names[0]!.name));
    const features = { brand_names: names.length, brand_matches_domain: matchesDomain.length > 0 ? 1 : 0, brand_names_agree: agree ? 1 : 0 };
    if (matchesDomain.length > 0 || agree) {
      return {
        status: "pass",
        findings: [],
        recommendation: "",
        confidence: matchesDomain.length > 0 ? "high" : "medium",
        summary: matchesDomain.length > 0 ? `The site name (${matchesDomain[0]!.name}) matches the domain.` : `The site consistently calls itself "${names[0]!.name}", which differs from the domain ${domain} — fine for a brand name.`,
        features,
      };
    }
    return {
      status: "warn",
      confidence: "medium",
      findings: names.map((n) => ({ message: `${n.source}: "${n.name}"` })),
      recommendation: `Use one name across the title, logo, og:site_name and organisation markup, ideally related to ${domain}. Mixed names can look like a site assembled from templates.`,
      summary: `The site uses several names, none matching ${domain}.`,
      features,
    };
  },
};
