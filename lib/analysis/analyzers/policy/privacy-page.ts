import { load, type CheerioAPI } from "cheerio";

import type { AnalyzerContext } from "../contract";
import { hostOf, isOwnHost, mainContent } from "../util";

type Kind = "privacy" | "contact" | "about" | "terms";

const PATTERN: Record<Kind, RegExp> = {
  privacy: /privacy|datenschutz|privacidad/i,
  contact: /contact|kontakt|reach-?us|get-?in-?touch/i,
  about: /about|who-?we-?are|our-?story/i,
  terms: /terms|conditions|disclaimer/i,
};

export type LinkedPage = { url: string; $: CheerioAPI; text: string; html: string };

/**
 * Finds and reads one of the site's standard pages: the link the engine
 * found on the homepage, else any matching link on a page this scan read.
 * A page already read is reused; otherwise it is fetched once through the
 * shared crawl, so analyzers that need the same page share one request.
 */
export async function loadLinkedPage(ctx: AnalyzerContext, kind: Kind): Promise<LinkedPage | null> {
  let url = ctx.siteMeta.policyLinks[kind]?.url ?? null;
  if (!url) {
    outer: for (const page of ctx.crawledPages) {
      for (const link of page.analysis.links) {
        if (!link.absolute || !isOwnHost(hostOf(link.absolute), ctx.siteMeta.host)) continue;
        let path = "";
        try {
          path = new URL(link.absolute).pathname;
        } catch {
          continue;
        }
        if (PATTERN[kind].test(path) || PATTERN[kind].test(link.text)) {
          url = link.absolute;
          break outer;
        }
      }
    }
  }
  if (!url) return null;

  const read = ctx.crawledPages.find((page) => page.url === url || page.finalUrl === url);
  if (read) {
    const $ = read.$();
    return { url: read.finalUrl, $, text: mainContent($), html: read.html };
  }
  const result = await ctx.fetchResource(url, { maxBytes: 1024 * 1024 });
  if (!result || !result.ok || result.body.length === 0) return null;
  const $ = load(result.body);
  return { url: result.finalUrl, $, text: mainContent($), html: result.body };
}

/** The privacy policy, for the privacy analyzers. */
export function loadPrivacyPage(ctx: AnalyzerContext): Promise<LinkedPage | null> {
  return loadLinkedPage(ctx, "privacy");
}
