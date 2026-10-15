import type { AnalyzerDef } from "../contract";
import { textOfSelection } from "../util";

/**
 * The year in the site's copyright notice. A notice that stopped at an
 * old year reads as an abandoned site.
 *
 * Only a copyright notice counts — "©", "&copy;" or "Copyright" next to a
 * year, in the footer (or, without a footer element, the last part of the
 * page) — so a historical year elsewhere in an article is never flagged.
 * Ranges ("2019–2024") count by their last year.
 */

const NOTICE = /(?:©|\(c\)|&copy;|copyright)\s*(?:©\s*)?((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi;

export const analyzer: AnalyzerDef = {
  key: "stale_copyright_year",
  name: "Stale copyright year",
  category: "trust",
  defaultPlan: "free",
  scope: "site",
  weight: 1,
  failPriority: "low",
  warnPriority: "low",
  run(ctx) {
    const now = new Date(ctx.now);
    const page = ctx.siteMeta.home;
    const $ = page.$();
    const footer = $("footer, [role=contentinfo], #footer, .footer, .site-footer");
    const region = footer.length
      ? textOfSelection(footer)
      : (() => {
          const all = textOfSelection($("body"));
          return all.slice(Math.floor(all.length * 0.8));
        })();

    const years: number[] = [];
    for (const match of region.matchAll(NOTICE)) {
      const last = Number(match[2] ?? match[1]);
      if (last <= now.getUTCFullYear() + 1) years.push(last);
    }
    const current = now.getUTCFullYear();

    if (years.length === 0) {
      return { status: "pass", findings: [], recommendation: "", confidence: "medium", summary: "No dated copyright notice found, so there is nothing out of date." };
    }
    const latest = Math.max(...years);
    if (latest >= current - 1) {
      return { status: "pass", findings: [], recommendation: "", summary: `The copyright notice is current (${latest}).`, features: { copyright_age_years: current - latest } };
    }
    return {
      status: "warn",
      findings: [{ message: `The footer's copyright notice stops at ${latest}.`, evidence: `© ${latest}`, pageUrl: page.finalUrl }],
      recommendation: `Update the copyright year (or show a range ending in ${current}) so the site does not look abandoned. Many themes can print the current year automatically.`,
      features: { copyright_age_years: current - latest },
    };
  },
};
