import type { AnalyzerDef } from "../contract";
import { registeredDomain } from "./domain_age_whois";

/**
 * A cautious signal from the domain's top-level domain alone.
 *
 * Some TLDs have been free or very cheap and, as a result, are heavily used
 * for spam and throwaway sites; reviewers and filters can be warier of
 * them. The weights below are a local, versioned judgement (0 = no
 * concern, 1 = high) — not data from Google — and a TLD is never proof
 * that a particular site is bad, so this only ever warns.
 */

export const TLD_TABLE_VERSION = "2026-10";

export const TLD_WEIGHTS: Record<string, number> = {
  // Formerly free (Freenom) and widely abused.
  tk: 0.9, ml: 0.9, ga: 0.9, cf: 0.9, gq: 0.9,
  // Very cheap, frequently seen on throwaway and spam sites.
  top: 0.7, xyz: 0.6, icu: 0.7, buzz: 0.6, cyou: 0.7, rest: 0.6, monster: 0.6, cfd: 0.7, sbs: 0.7, bond: 0.6, click: 0.6, link: 0.5, work: 0.6,
  loan: 0.8, win: 0.7, bid: 0.7, date: 0.7, review: 0.6, stream: 0.6, download: 0.7, racing: 0.7, men: 0.7, party: 0.7, trade: 0.6, science: 0.6, accountant: 0.7, faith: 0.7, cricket: 0.6, webcam: 0.7, gdn: 0.7, kim: 0.6, country: 0.6,
  // Ordinary.
  com: 0, org: 0, net: 0.1, edu: 0, gov: 0, in: 0.1, uk: 0, de: 0, fr: 0, au: 0, ca: 0, io: 0.1, co: 0.1, info: 0.3, online: 0.3, site: 0.4, website: 0.4, store: 0.3, shop: 0.3, blog: 0.1, app: 0.1, dev: 0.1, me: 0.2, biz: 0.4,
};

export const analyzer: AnalyzerDef = {
  key: "tld_risk",
  name: "Top-level domain signal",
  category: "trust",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  run(ctx) {
    const domain = registeredDomain(ctx.siteMeta.host);
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    const known = Object.prototype.hasOwnProperty.call(TLD_WEIGHTS, tld);
    const weight = known ? TLD_WEIGHTS[tld]! : 0.2;
    const features = { tld_weight: weight };
    if (weight < 0.6) {
      return { status: "pass", findings: [], recommendation: "", confidence: known ? "medium" : "low", summary: `.${tld} carries no particular reputation signal (local table ${TLD_TABLE_VERSION}${known ? "" : "; this TLD is not in the table"}).`, features };
    }
    return {
      status: "warn",
      confidence: "low",
      findings: [{ message: `.${tld} is a TLD often used by throwaway and spam sites, so reviewers may look more closely.`, evidence: `Weight ${weight} in the local table (${TLD_TABLE_VERSION})` }],
      recommendation: "A TLD alone does not decide approval. If you are starting out, a mainstream TLD (.com, .org or your country's) is the safer choice; otherwise make sure the site itself is clearly genuine.",
      features,
    };
  },
};
