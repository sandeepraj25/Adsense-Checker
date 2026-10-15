import type { AnalyzerContext, AnalyzerDef } from "../contract";
import { publicationDates } from "../util";

/**
 * Bursts of publishing — dozens of posts on one day — which can point to
 * bulk-generated or imported content.
 *
 * Dates come from the articles read and from the sitemap's <lastmod>.
 * lastmod is the last *change*, not first publication, so a theme or
 * plugin update that touches every URL looks like a burst: when most of
 * the sitemap shares one date, that is reported as a site-wide update, not
 * as publishing. A day with 30+ new dates otherwise is a warning — it may
 * still be a migration or archive import, which only you can confirm.
 */

const BURST = 30;
const SITEMAP = { accept: "application/xml,text/xml", maxBytes: 512 * 1024, timeoutMs: 10_000 } as const;

async function sitemapDates(ctx: AnalyzerContext): Promise<string[]> {
  const robots = await ctx.robots();
  const roots = [...new Set([...(robots?.sitemaps ?? []), `${ctx.siteMeta.origin}/sitemap.xml`])].slice(0, 3);
  const dates: string[] = [];
  const read = async (url: string, depth: number) => {
    if (dates.length >= 5000 || ctx.remainingMs() < 1500) return;
    const file = await ctx.fetchResource(url, SITEMAP);
    if (!file || !file.ok) return;
    const body = file.body;
    if (/<sitemapindex\b/i.test(body) && depth === 0) {
      const children = [...body.matchAll(/<loc\b[^>]*>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!).slice(0, 3);
      for (const child of children) await read(child, 1);
      return;
    }
    for (const m of body.matchAll(/<url\b[\s\S]*?<\/url>/gi)) {
      const lastmod = m[0].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1];
      if (lastmod && /^\d{4}-\d{2}-\d{2}/.test(lastmod)) dates.push(lastmod.slice(0, 10));
      if (dates.length >= 5000) break;
    }
  };
  for (const root of roots) await read(root, 0);
  return dates;
}

function perDay(dates: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export const analyzer: AnalyzerDef = {
  key: "publishing_velocity",
  name: "Publishing pattern",
  category: "content",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  async run(ctx) {
    const articleDates = ctx.crawledPages.flatMap((p) => publicationDates(p, ctx.now).slice(0, 1).map((d) => d.date.toISOString().slice(0, 10)));
    const lastmods = await sitemapDates(ctx);
    const all = [...articleDates, ...lastmods];
    if (all.length < 5) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `Not enough dated pages to judge the publishing pattern (${all.length} found).` };
    }
    const days = perDay(lastmods.length >= articleDates.length ? lastmods : articleDates);
    const [topDay, topCount] = days[0] ?? ["", 0];
    const total = lastmods.length >= articleDates.length ? lastmods.length : articleDates.length;
    const recent = all.filter((d) => ctx.now - Date.parse(d) <= 90 * 86_400_000).length;
    const features = { max_posts_per_day: topCount, dated_urls: total, dated_last_90_days: recent };
    const source = lastmods.length >= articleDates.length ? "sitemap lastmod dates" : "article dates";

    if (topCount >= BURST && topCount / total >= 0.8) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `${topCount} of ${total} ${source} share ${topDay} — a site-wide update or import, not a publishing burst.`, features };
    }
    if (topCount >= BURST) {
      return {
        status: "warn",
        confidence: source === "article dates" ? "medium" : "low",
        findings: days.filter(([, n]) => n >= BURST).slice(0, 5).map(([day, n]) => ({ message: `${n} URLs dated ${day}.`, evidence: `From ${source}` })),
        recommendation: "If these are new posts published at once, spread publishing out and make sure each is substantial and original. If it was a migration or archive import, no action is needed.",
        summary: `${topCount} URLs were dated on a single day (${topDay}), from ${source}.`,
        features,
      };
    }
    return { status: "pass", findings: [], recommendation: "", confidence: source === "article dates" ? "medium" : "low", summary: `No publishing bursts: at most ${topCount} URL(s) on one day across ${total} ${source}; ${recent} dated in the last 90 days.`, features };
  },
};
