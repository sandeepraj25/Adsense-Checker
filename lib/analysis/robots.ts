/**
 * robots.txt rules for deciding what the crawler itself may fetch
 * (RFC 9309).
 *
 *   - Rules are grouped by user-agent. A crawler obeys the most specific
 *     group naming it, else the `*` group, else nothing is disallowed.
 *   - Within a group the longest matching path wins; on a tie, Allow wins.
 *   - `*` matches any run of characters and a trailing `$` anchors the end.
 *
 * Kept free of I/O so it can be tested directly. The existing robots and
 * crawlability checks keep their own reading of the file; this module only
 * decides whether *we* are welcome on a page.
 */

type Rule = { allow: boolean; pattern: string; regex: RegExp };
type Group = { agents: string[]; rules: Rule[] };

export type RobotsRules = {
  /** True when the path may be fetched by a crawler with this token. */
  allows(pathAndQuery: string, agentToken: string): boolean;
  /** Sitemap URLs listed anywhere in the file. */
  sitemaps: string[];
  /** The file had at least one group or sitemap line. */
  meaningful: boolean;
};

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Percent-encoding is compared in one canonical form, as the RFC asks. */
function normalisePath(path: string): string {
  try {
    return encodeURI(decodeURI(path));
  } catch {
    return path;
  }
}

export function parseRobotsRules(text: string): RobotsRules {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.slice(0, 512 * 1024).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if ((key === "allow" || key === "disallow") && current) {
      // An empty Disallow means "nothing is disallowed" and adds no rule.
      if (!value) continue;
      const pattern = normalisePath(value);
      current.rules.push({ allow: key === "allow", pattern, regex: compile(pattern) });
    }
  }

  function groupFor(token: string): Group | null {
    const wanted = token.toLowerCase();
    // The most specific (longest) agent name contained in our token wins.
    let best: { group: Group; length: number } | null = null;
    for (const group of groups) {
      for (const agent of group.agents) {
        if (agent !== "*" && wanted.includes(agent) && (!best || agent.length > best.length)) {
          best = { group, length: agent.length };
        }
      }
    }
    if (best) return best.group;
    return groups.find((group) => group.agents.includes("*")) ?? null;
  }

  return {
    sitemaps,
    meaningful: groups.length > 0 || sitemaps.length > 0,
    allows(pathAndQuery, agentToken) {
      const path = normalisePath(pathAndQuery || "/");
      if (path === "/robots.txt") return true;
      const group = groupFor(agentToken);
      if (!group) return true;
      let match: Rule | null = null;
      for (const rule of group.rules) {
        if (!rule.regex.test(path)) continue;
        if (
          !match ||
          rule.pattern.length > match.pattern.length ||
          (rule.pattern.length === match.pattern.length && rule.allow && !match.allow)
        ) {
          match = rule;
        }
      }
      return match ? match.allow : true;
    },
  };
}
