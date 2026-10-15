import { randomBytes } from "node:crypto";

import type { AnalyzerContext, SiteMeta } from "../contract";
import type { FetchResult } from "../../fetcher";

/**
 * One address per scan that cannot exist, shared by the Soft 404 and
 * Custom 404 analyzers: the same URL with the same options, so the crawl
 * fetches it once and both read the same answer.
 */

const URLS = new WeakMap<SiteMeta, string>();
export const MISSING_PAGE_OPTIONS = { maxBytes: 256 * 1024, timeoutMs: 8_000 } as const;

export function missingPageUrl(site: SiteMeta): string {
  let url = URLS.get(site);
  if (!url) {
    url = `${site.origin}/zz-${randomBytes(6).toString("hex")}-page-check`;
    URLS.set(site, url);
  }
  return url;
}

export function fetchMissingPage(ctx: AnalyzerContext): Promise<FetchResult | null> {
  return ctx.fetchResource(missingPageUrl(ctx.siteMeta), MISSING_PAGE_OPTIONS);
}
