import type { AnalyzerDef } from "../contract";
import { hostOf, isOwnHost } from "../util";

/**
 * How many other domains the site loads JavaScript from, across the pages
 * read. Each one adds a connection, download and code you don't control.
 * More than 10 distinct domains is a warning.
 */

export const analyzer: AnalyzerDef = {
  key: "third_party_scripts",
  name: "Third-party scripts",
  category: "technical",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  run(ctx) {
    const domains = new Map<string, string>();
    for (const page of ctx.crawledPages.filter((p) => p.ok)) {
      const $ = page.$();
      $("script[src]").each((_, el) => {
        const src = $(el).attr("src") ?? "";
        const host = hostOf(src, page.finalUrl);
        if (host && !isOwnHost(host, ctx.siteMeta.host) && !domains.has(host)) domains.set(host, src);
      });
    }
    const list = [...domains.keys()].sort();
    const features = { third_party_script_domains: list.length };
    const summary = list.length === 0 ? "No scripts from other domains." : `${list.length} script domain(s): ${list.slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""}.`;
    if (list.length <= 10) return { status: "pass", findings: [], recommendation: "", summary, features };
    return {
      status: "warn",
      findings: list.map((host) => ({ message: host, evidence: domains.get(host)!.slice(0, 160) })),
      recommendation: "Remove plugins, widgets and trackers you no longer use, and load the rest with async/defer. Fewer third-party scripts mean faster pages and fewer surprises.",
      summary,
      features,
    };
  },
};
