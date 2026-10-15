import type { AnalyzerDef } from "../contract";
import { publicationDates } from "../util";

/**
 * How long since the newest article we can date was published.
 *
 * Dates come from article metadata, structured data, <time> tags and
 * dated URLs on the pages this scan read, and the source is reported.
 * Without any verifiable date the result is "uncertain", never a guess.
 * An old site is not a policy breach, so this warns rather than fails.
 */

const DAY = 86_400_000;

export const analyzer: AnalyzerDef = {
  key: "content_freshness",
  name: "Content freshness",
  category: "content",
  defaultPlan: "basic",
  scope: "site",
  weight: 2,
  failPriority: "low",
  warnPriority: "low",
  run(ctx) {
    const dates = ctx.crawledPages.flatMap((page) => publicationDates(page, ctx.now));
    if (dates.length === 0) {
      return {
        status: "warn",
        confidence: "low",
        findings: [],
        recommendation: "Show a published (or updated) date on each article and mark it up with <time datetime=…> so readers and crawlers can see the site is maintained.",
        summary: "Uncertain: none of the pages we read carry a date we could verify.",
      };
    }
    dates.sort((a, b) => b.date.getTime() - a.date.getTime());
    const newest = dates[0]!;
    const days = Math.max(0, Math.floor((ctx.now - newest.date.getTime()) / DAY));
    const when = newest.date.toISOString().slice(0, 10);
    const base = { features: { days_since_newest: days, dated_pages: new Set(dates.map((d) => d.pageUrl)).size } };
    if (days <= 90) {
      return { ...base, status: "pass", findings: [], recommendation: "", summary: `Newest article ${when} (${days} days ago, from its ${newest.source}).` };
    }
    return {
      ...base,
      status: "warn",
      confidence: dates.length > 1 ? "medium" : "low",
      findings: [{ message: `The newest dated article we found is ${days} days old.`, evidence: `${when}, from its ${newest.source}`, pageUrl: newest.pageUrl }],
      recommendation: days > 365 ? "Publish new articles regularly before applying; a site with no new content for over a year reads as abandoned." : "Keep publishing on a regular schedule so the site shows it is actively maintained.",
      summary: `Newest article ${when} (${days} days ago, from its ${newest.source}).`,
    };
  },
};
