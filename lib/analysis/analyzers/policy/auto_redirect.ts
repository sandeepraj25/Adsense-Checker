import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost } from "../util";

/**
 * Pages that send the visitor somewhere else by themselves.
 *
 *   - <meta http-equiv="refresh"> with a URL: to another site is a fail,
 *     to this site a warning; a plain timed reload is a warning.
 *   - A script assigning location / location.href or calling
 *     location.replace/assign with a literal URL, outside a click handler.
 *     Scripts are not run, so this is reported as "likely", not certain.
 *   - The page's own HTTP redirects ending on a different site.
 */

export function scriptRedirects(script: string): Array<{ url: string; evidence: string }> {
  const out: Array<{ url: string; evidence: string }> = [];
  const re = /(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']{4,500})["']|location\.(?:replace|assign)\s*\(\s*["']([^"']{4,500})["']\s*\)/g;
  for (const match of script.matchAll(re)) {
    const before = script.slice(Math.max(0, match.index! - 250), match.index);
    // Inside a click/submit handler it is the visitor's own action.
    if (/addEventListener\(\s*["'](?:click|submit|mousedown|touchstart|change|keydown)|\bon(?:click|submit|change)\b/i.test(before)) continue;
    out.push({ url: (match[1] ?? match[2] ?? "").trim(), evidence: match[0].slice(0, 120) });
  }
  return out;
}

export const analyzer: AnalyzerDef = {
  key: "auto_redirect",
  name: "Automatic redirects",
  category: "policy",
  defaultPlan: "pro",
  scope: "page",
  weight: 4,
  failPriority: "high",
  warnPriority: "medium",
  run(ctx) {
    const $ = ctx.$;
    const site = ctx.siteMeta.host;
    const findings: AnalyzerFinding[] = [];
    let external = 0;
    let internal = 0;

    $('meta[http-equiv]').each((_, el) => {
      if (($(el).attr("http-equiv") ?? "").toLowerCase() !== "refresh") return;
      const content = $(el).attr("content") ?? "";
      const delay = Number(content.match(/^\s*(\d+)/)?.[1] ?? "0");
      const target = content.match(/url\s*=\s*['"]?([^'";]+)/i)?.[1]?.trim();
      if (!target) {
        internal += 1;
        findings.push({ message: `The page reloads itself every ${delay} seconds.`, evidence: `<meta http-equiv="refresh" content="${content.slice(0, 80)}">`, pageUrl: ctx.url });
        return;
      }
      const host = hostOf(target, ctx.url);
      const away = Boolean(host) && !isOwnHost(host, site);
      if (away) external += 1;
      else internal += 1;
      findings.push({ message: `A meta refresh sends visitors to ${away ? `another site (${host})` : "another page"} after ${delay} seconds.`, evidence: `<meta http-equiv="refresh" content="${content.slice(0, 120)}">`, pageUrl: ctx.url });
    });

    const scripts = $("script:not([src])").map((_, el) => $(el).text()).get().join("\n;\n").slice(0, 1_000_000);
    for (const redirect of scriptRedirects(scripts)) {
      const host = hostOf(redirect.url, ctx.url);
      if (!host) continue;
      const away = !isOwnHost(host, site);
      if (away) external += 1;
      else internal += 1;
      if (findings.length < 6) findings.push({ message: `A script likely redirects visitors to ${away ? `another site (${host})` : "another page on this site"} without a click.`, evidence: redirect.evidence, pageUrl: ctx.url });
    }

    if (ctx.page.redirects.length > 0) {
      const from = hostOf(ctx.page.url);
      const to = hostOf(ctx.page.finalUrl);
      if (from && to && !isOwnHost(to, from) && !isOwnHost(from, to)) {
        external += 1;
        findings.push({ message: `The address redirects to a different site (${to}).`, evidence: `${ctx.page.url} → ${ctx.page.finalUrl}`, pageUrl: ctx.page.url });
      }
    }

    const features = { redirects_external: external, redirects_internal: internal };
    if (findings.length === 0) return { status: "pass", findings: [], recommendation: "", summary: "No automatic redirects found.", features };
    return {
      status: external > 0 ? "fail" : "warn",
      confidence: "medium",
      findings,
      recommendation: "Remove automatic redirects and timed refreshes. Send visitors to another page only when they click; use a server (301) redirect for moved pages.",
      features,
    };
  },
};
