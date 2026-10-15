import type { AnalyzerDef, AnalyzerFinding } from "../contract";
import { hostOf, isOwnHost } from "../util";

/**
 * Untidy internal URLs: session IDs in the address, very long query
 * strings, and WordPress's default "?p=123" links. These are search and
 * usability signals (duplicate URLs, unreadable links), not policy
 * violations, so they only warn.
 */

const SESSION = /[?&;](?:phpsessid|jsessionid|sessionid|session_id|sessid|sid)=[a-z0-9-]{16,}/i;
const DEFAULT_PERMALINK = /^\/(?:index\.php)?$/;
const DEFAULT_PARAM = /^(?:p|page_id|cat|m)$/;

export function urlProblems(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const problems: string[] = [];
  if (SESSION.test(parsed.search) || /;jsessionid=/i.test(parsed.pathname)) problems.push("a session ID in the URL");
  if (parsed.search.length > 100 || [...parsed.searchParams.keys()].length > 4) problems.push("a long query string");
  if (DEFAULT_PERMALINK.test(parsed.pathname) && [...parsed.searchParams.keys()].some((k) => DEFAULT_PARAM.test(k) && /^\d+$/.test(parsed.searchParams.get(k) ?? ""))) problems.push("a default ?p=123 style link");
  return problems;
}

export const analyzer: AnalyzerDef = {
  key: "url_hygiene",
  name: "URL hygiene",
  category: "technical",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  run(ctx) {
    const urls = new Set<string>();
    for (const page of ctx.crawledPages) {
      urls.add(page.finalUrl);
      for (const link of page.analysis.links) if (link.absolute && isOwnHost(hostOf(link.absolute), ctx.siteMeta.host)) urls.add(link.absolute);
    }
    const findings: AnalyzerFinding[] = [];
    const counts = new Map<string, number>();
    for (const url of urls) {
      for (const problem of urlProblems(url)) {
        counts.set(problem, (counts.get(problem) ?? 0) + 1);
        if (findings.length < 10) findings.push({ message: `Internal link with ${problem}.`, evidence: url.slice(0, 200) });
      }
    }
    const features = { urls_checked: urls.size, url_problems: [...counts.values()].reduce((a, b) => a + b, 0) };
    if (findings.length === 0) return { status: "pass", findings: [], recommendation: "", summary: `${urls.size} internal URLs checked; all are clean.`, features };
    return {
      status: "warn",
      findings,
      recommendation: "Use readable permalinks (Settings → Permalinks → Post name in WordPress), keep session IDs in cookies rather than URLs, and avoid long tracking parameters on internal links.",
      summary: `${[...counts].map(([p, n]) => `${n} with ${p}`).join("; ")} among ${urls.size} internal URLs.`,
      features,
    };
  },
};
