import type { AnalyzerDef } from "../contract";
import { hostOf } from "../util";

/**
 * Total download size of the homepage: the HTML plus the stylesheets,
 * scripts, images and preloaded fonts it references (up to 30 files),
 * measured by downloading each one through the shared crawl. Files that
 * could not be downloaded (or were cut off at 2 MB) are reported as not
 * measured or as "at least", never estimated. Resources that scripts load
 * later are not seen. Over 3 MB is a warning: heavy pages load slowly on
 * mobile connections.
 */

const MAX_FILES = 30;
const LIMIT = 3 * 1024 * 1024;
const OPTIONS = { accept: "*/*", maxBytes: 2 * 1024 * 1024, timeoutMs: 6_000 } as const;

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export const analyzer: AnalyzerDef = {
  key: "page_weight",
  name: "Page weight",
  category: "technical",
  defaultPlan: "pro",
  scope: "site",
  weight: 1,
  warnPriority: "low",
  timeoutMs: 25_000,
  async run(ctx) {
    const home = ctx.siteMeta.home;
    const $ = home.$();
    const refs: Array<{ url: string; type: "css" | "js" | "image" | "font" }> = [];
    const add = (raw: string | undefined, type: "css" | "js" | "image" | "font") => {
      if (!raw || raw.startsWith("data:") || refs.length >= MAX_FILES) return;
      try {
        const url = new URL(raw.trim().split(/\s+/)[0]!, home.finalUrl).toString();
        if (hostOf(url) && !refs.some((r) => r.url === url)) refs.push({ url, type });
      } catch {
        /* skip malformed */
      }
    };
    $('link[rel~="stylesheet"][href]').each((_, el) => add($(el).attr("href"), "css"));
    $("script[src]").each((_, el) => add($(el).attr("src"), "js"));
    $('link[rel="preload"][as="font"][href]').each((_, el) => add($(el).attr("href"), "font"));
    $("img").slice(0, 15).each((_, el) => add($(el).attr("src") || $(el).attr("data-src"), "image"));

    const results = await Promise.all(refs.map(async (ref) => ({ ref, file: await ctx.fetchResource(ref.url, OPTIONS) })));
    const byType: Record<string, number> = { html: home.bytes, css: 0, js: 0, image: 0, font: 0 };
    let unmeasured = 0;
    let atLeast = home.truncated;
    for (const { ref, file } of results) {
      if (!file || !file.ok) {
        unmeasured += 1;
        continue;
      }
      byType[ref.type] = (byType[ref.type] ?? 0) + file.bytes;
      atLeast ||= file.truncated;
    }
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(byType).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${mb(v)}`).join(", ");
    const features = { page_bytes: total, page_files: refs.length - unmeasured + 1 };
    const summary = `${atLeast ? "At least " : ""}${mb(total)} across ${refs.length - unmeasured + 1} file(s) (${breakdown})${unmeasured ? `; ${unmeasured} file(s) could not be measured` : ""}.`;
    if (total <= LIMIT) return { status: "pass", findings: [], recommendation: "", confidence: unmeasured ? "medium" : "high", summary, features };
    const biggest = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]!;
    return {
      status: "warn",
      findings: [{ message: `The homepage downloads ${atLeast ? "at least " : ""}${mb(total)}; ${biggest[0]} is the largest part (${mb(biggest[1])}).`, pageUrl: home.finalUrl }],
      recommendation: "Compress and resize images (WebP/AVIF at display size), lazy-load images below the fold, and remove scripts and stylesheets the page doesn't need.",
      summary,
      features,
    };
  },
};
