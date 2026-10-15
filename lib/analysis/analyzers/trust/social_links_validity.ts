import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf } from "../util";

/**
 * Social media links that point to an actual profile, rather than to the
 * network's homepage — the leftover "facebook.com" icon of a theme demo.
 * Share buttons (sharer, intent, pin/create) are ignored. Profiles are
 * not visited, so a link that looks like a profile is not claimed to be
 * active.
 */

const NETWORKS: Array<{ name: string; hosts: RegExp }> = [
  { name: "Facebook", hosts: /(?:^|\.)(?:facebook\.com|fb\.com)$/i },
  { name: "X / Twitter", hosts: /(?:^|\.)(?:twitter\.com|x\.com)$/i },
  { name: "Instagram", hosts: /(?:^|\.)instagram\.com$/i },
  { name: "LinkedIn", hosts: /(?:^|\.)linkedin\.com$/i },
  { name: "YouTube", hosts: /(?:^|\.)youtube\.com$/i },
  { name: "Pinterest", hosts: /(?:^|\.)pinterest\.[a-z.]+$/i },
  { name: "TikTok", hosts: /(?:^|\.)tiktok\.com$/i },
  { name: "Threads", hosts: /(?:^|\.)threads\.net$/i },
  { name: "Telegram", hosts: /(?:^|\.)(?:t\.me|telegram\.me)$/i },
  { name: "GitHub", hosts: /(?:^|\.)github\.com$/i },
  { name: "Reddit", hosts: /(?:^|\.)reddit\.com$/i },
  { name: "Medium", hosts: /(?:^|\.)medium\.com$/i },
];
const SHARE = /\/(?:sharer|share|intent|dialog|shareArticle|pin\/create|submit|sharing)\b|[?&](?:u|url|text)=/i;
const GENERIC = new Set(["home", "login", "signup", "explore", "feed", "about", "help", "settings", "search", "hashtag", "watch", "en", "en-us", "en-gb", "in", "pages", "groups", "company", "results"]);

export function socialKind(href: string): { network: string; kind: "profile" | "homepage" | "share" } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  const network = NETWORKS.find((n) => n.hosts.test(host));
  if (!network) return null;
  if (SHARE.test(url.pathname + url.search)) return { network: network.name, kind: "share" };
  const segments = url.pathname.split("/").filter(Boolean);
  const meaningful = segments.filter((s) => !GENERIC.has(s.toLowerCase()));
  // "/company/acme" and "/watch?v=…" still carry an identifier.
  if (meaningful.length > 0 || (segments.includes("watch") && url.searchParams.has("v"))) return { network: network.name, kind: "profile" };
  return { network: network.name, kind: "homepage" };
}

export const analyzer: AnalyzerDef = {
  key: "social_links_validity",
  name: "Social media links",
  category: "trust",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  run(ctx) {
    const seen = new Map<string, { network: string; kind: string; page: string }>();
    for (const page of ctx.crawledPages.filter((p) => p.ok)) {
      for (const link of page.analysis.links) {
        if (!link.absolute || seen.has(link.absolute) || !hostOf(link.absolute)) continue;
        const kind = socialKind(link.absolute);
        if (kind && kind.kind !== "share") seen.set(link.absolute, { ...kind, page: page.finalUrl });
      }
    }
    const profiles = [...seen.values()].filter((v) => v.kind === "profile");
    const bare = [...seen].filter(([, v]) => v.kind === "homepage");
    const features = { social_profiles: profiles.length, social_bare_links: bare.length };
    if (seen.size === 0) return { status: "pass", findings: [], recommendation: "", summary: "No social media links.", features };
    if (bare.length === 0) {
      return { status: "pass", findings: [], recommendation: "", confidence: "medium", summary: `${profiles.length} social link(s) point to specific profiles (${[...new Set(profiles.map((p) => p.network))].join(", ")}); they were not visited to confirm they are active.`, features };
    }
    const findings: AnalyzerFinding[] = bare.slice(0, 8).map(([href, v]) => ({ message: `The ${v.network} link goes to the network's homepage, not to a profile.`, evidence: href, pageUrl: v.page }));
    return {
      status: "warn",
      findings,
      recommendation: "Point each social icon at your own profile, or remove icons for networks you don't use. Links to a bare facebook.com or twitter.com are theme leftovers.",
      features,
    };
  },
};
