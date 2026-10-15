import type { AnalyzerDef } from "../contract";
import { whoisLookup } from "../../whois";

/**
 * How long ago the domain was registered, from the registry's WHOIS
 * server (lib/analysis/whois.ts: TCP port 43, cached, rate-limited).
 *
 * A domain under six months old is a warning: some AdSense markets have
 * asked for around six months of history, and young sites are often thin.
 * It is never a fail on its own. When the registry gives no date (some
 * ccTLDs publish none) the result says so instead of guessing.
 */

/** Second-level registry suffixes, so blog.example.co.uk looks up example.co.uk. */
const MULTI = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "gov.in", "res.in", "com.au", "net.au", "org.au", "co.nz", "com.br", "com.mx", "com.ar", "co.za", "com.sg", "com.my", "co.jp", "co.kr", "com.cn", "com.tw", "com.hk", "com.tr", "com.pk", "com.bd", "com.ng", "com.ph", "co.id", "or.id", "com.vn", "com.eg", "com.sa"]);

export function registeredDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

const DAY = 86_400_000;

export const analyzer: AnalyzerDef = {
  key: "domain_age_whois",
  name: "Domain age (WHOIS)",
  category: "trust",
  defaultPlan: "pro",
  scope: "site",
  weight: 2,
  warnPriority: "low",
  timeoutMs: 20_000,
  async run(ctx) {
    const domain = registeredDomain(ctx.siteMeta.host);
    const result = await whoisLookup(domain, { budgetMs: Math.min(18_000, ctx.remainingMs() - 500), now: ctx.now });
    const source = result.server ? `${result.server}${result.cached ? ", cached" : ""}` : "WHOIS";
    if (result.status !== "found" || result.createdOn === null) {
      return {
        status: "warn",
        confidence: "low",
        findings: [{ message: `Domain age could not be verified: ${result.detail}`, evidence: `${domain} via ${source}` }],
        recommendation: "",
        summary: `Domain age not verified: ${result.detail}`,
        features: { domain_age_known: 0 },
      };
    }
    const days = Math.max(0, Math.floor((ctx.now - result.createdOn) / DAY));
    const months = Math.floor(days / 30.44);
    const date = new Date(result.createdOn).toISOString().slice(0, 10);
    const features = { domain_age_known: 1, domain_age_days: days };
    if (days >= 183) {
      return { status: "pass", findings: [], recommendation: "", summary: `${domain} was registered on ${date} (${months >= 24 ? `${Math.floor(months / 12)} years` : `${months} months`} ago, from ${source}).`, features };
    }
    return {
      status: "warn",
      findings: [{ message: `${domain} was registered ${months < 1 ? `${days} days` : `${months} months`} ago.`, evidence: `Created ${date} (${source})` }],
      recommendation: "A young domain is not a policy breach, but some AdSense markets have asked for around six months of history. Keep publishing and apply once the site has a track record.",
      features,
    };
  },
};
