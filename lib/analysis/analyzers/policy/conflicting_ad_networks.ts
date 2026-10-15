import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf } from "../util";

/**
 * Ad scripts that clash with AdSense: pop-under networks and push-
 * notification ad networks, matched against a local, versioned list of
 * script hosts. Known pop-under networks fail; push-ad networks and code
 * that merely mentions "popunder" are warnings, because a name match is
 * not proof of how the script is used. Ordinary push-notification
 * services (not ad networks) are not listed.
 *
 * Edit SIGNATURES to update the list; bump SIGNATURE_VERSION with it.
 */

export const SIGNATURE_VERSION = "2026-10";

export const SIGNATURES: Array<{ domains: string[]; network: string; kind: "popunder" | "push-ads" }> = [
  { domains: ["popads.net"], network: "PopAds", kind: "popunder" },
  { domains: ["popcash.net"], network: "PopCash", kind: "popunder" },
  { domains: ["propellerads.com"], network: "PropellerAds", kind: "popunder" },
  { domains: ["adcash.com"], network: "Adcash", kind: "popunder" },
  { domains: ["hilltopads.net", "hilltopads.com"], network: "HilltopAds", kind: "popunder" },
  { domains: ["clickadu.com"], network: "Clickadu", kind: "popunder" },
  { domains: ["exoclick.com", "magsrv.com"], network: "ExoClick", kind: "popunder" },
  { domains: ["juicyads.com"], network: "JuicyAds", kind: "popunder" },
  { domains: ["trafficjunky.net", "trafficjunky.com"], network: "TrafficJunky", kind: "popunder" },
  { domains: ["adsterra.com"], network: "Adsterra", kind: "popunder" },
  { domains: ["monetag.com"], network: "Monetag", kind: "popunder" },
  { domains: ["admaven.com"], network: "AdMaven", kind: "popunder" },
  { domains: ["richpush.co"], network: "RichPush", kind: "push-ads" },
  { domains: ["pushground.com"], network: "Pushground", kind: "push-ads" },
  { domains: ["evadav.com"], network: "Evadav", kind: "push-ads" },
];

function matchHost(host: string) {
  return SIGNATURES.find((s) => s.domains.some((d) => host === d || host.endsWith(`.${d}`)));
}

const MENTION = /\bpop[-_]?under\b|\bpopunder[A-Z_]?\w*/i;

export const analyzer: AnalyzerDef = {
  key: "conflicting_ad_networks",
  name: "Conflicting ad networks",
  category: "policy",
  defaultPlan: "pro",
  scope: "site",
  weight: 4,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const found = new Map<string, { kind: string; page: string; src: string }>();
    let mentions = 0;
    let mentionPage = "";
    for (const page of ctx.crawledPages.filter((p) => p.ok)) {
      const $ = page.$();
      $("script[src], iframe[src]").each((_, el) => {
        const src = $(el).attr("src") ?? "";
        const host = hostOf(src, page.finalUrl);
        if (!host) return;
        const hit = matchHost(host);
        if (hit && !found.has(hit.network)) found.set(hit.network, { kind: hit.kind, page: page.finalUrl, src });
      });
      // Loaders injected by inline code still name their domain.
      const inline = $("script:not([src])").map((_, el) => $(el).text()).get().join("\n").slice(0, 500_000);
      for (const s of SIGNATURES) {
        const domain = s.domains.find((d) => inline.includes(`//${d}`) || inline.includes(`.${d}`));
        if (domain && !found.has(s.network)) found.set(s.network, { kind: s.kind, page: page.finalUrl, src: `inline script loading ${domain}` });
      }
      if (MENTION.test(inline)) {
        mentions += 1;
        mentionPage ||= page.finalUrl;
      }
    }

    const findings: AnalyzerFinding[] = [...found].map(([network, hit]) => ({
      message: `${network} (${hit.kind === "popunder" ? "pop-under ads" : "push-notification ads"}) is loaded.`,
      evidence: hit.src.slice(0, 160),
      pageUrl: hit.page,
    }));
    const popunders = [...found.values()].filter((hit) => hit.kind === "popunder").length;
    if (found.size === 0 && mentions > 0) findings.push({ message: "Page code mentions pop-unders; the script could not be identified.", pageUrl: mentionPage });
    const features = { popunder_networks: popunders, push_ad_networks: found.size - popunders };
    if (findings.length === 0) return { status: "pass", findings: [], recommendation: "", summary: `No pop-under or push-ad networks found (signature list ${SIGNATURE_VERSION}).`, features };
    return {
      status: popunders > 0 ? "fail" : "warn",
      confidence: popunders > 0 ? "high" : "low",
      findings,
      recommendation: "Remove pop-under and push-notification ad networks before applying. They create the kind of disruptive experience AdSense does not allow alongside its ads.",
      features,
    };
  },
};
