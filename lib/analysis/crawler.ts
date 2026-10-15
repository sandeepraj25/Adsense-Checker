import { load, type CheerioAPI } from "cheerio";

import { ANALYSIS_TIMEOUT_MS } from "@/lib/env";

import { fetchGuarded, probe, type FetchResult } from "./fetcher";
import { analysePage, type PageAnalysis } from "./html";
import { parseRobotsRules, type RobotsRules } from "./robots";

/**
 * One crawl per scan, shared by every check and analyzer.
 *
 * Everything that goes over the network during a scan goes through here,
 * so that:
 *   - each URL is fetched at most once per variant (a second request for
 *     the same thing is served from memory);
 *   - the scan's wall-clock budget applies to every request, and a
 *     request in flight is cut to whatever time is left;
 *   - at most `concurrency` requests run at once;
 *   - content pages stop at `maxPages`;
 *   - inner pages that robots.txt closes to our crawler are not fetched;
 *   - every request, and every redirect hop of it, is screened against
 *     private and metadata addresses (fetchGuarded/probe do that per hop).
 *
 * The homepage itself is always fetched once: the site's owner asked for
 * this scan, and a robots.txt that blocks everything is one of the things
 * the report has to be able to say.
 */

/** The token our crawler answers to in robots.txt groups. */
export const CRAWLER_TOKEN = "AdSenseEligibilityChecker";

export type Clock = {
  /** How long the next request may take, never past the deadline; 0 = out of time. */
  allow(ms: number): number;
  /** True once a request was skipped for lack of time. */
  partial(): boolean;
  remaining(): number;
};

export function startClock(budgetMs: number): Clock {
  const deadline = Date.now() + budgetMs;
  let ranOut = false;
  return {
    allow(ms) {
      const left = deadline - Date.now();
      if (left < 500) {
        ranOut = true;
        return 0;
      }
      return Math.min(ms, left);
    },
    partial: () => ranOut,
    remaining: () => Math.max(0, deadline - Date.now()),
  };
}

/** A page read during the scan, with its parsed forms. */
export type CrawledPage = {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  headers: Record<string, string>;
  html: string;
  bytes: number;
  ms: number;
  redirects: string[];
  truncated: boolean;
  /** The structured reading the existing checks use. */
  analysis: PageAnalysis;
  /** A cheerio document, parsed on first use and then reused. */
  $(): CheerioAPI;
};

export type PageOutcome =
  | { kind: "page"; page: CrawledPage }
  | { kind: "error"; url: string; status: number }
  | { kind: "skipped"; url: string; reason: "time" | "robots" | "budget" };

export type ResourceOptions = {
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Fetch as a different user agent (the cloaking comparison only). */
  userAgent?: string;
};

export type CrawlStats = {
  requests: number;
  cacheHits: number;
  skippedForTime: number;
  skippedByRobots: number;
  skippedForBudget: number;
};

export type CrawlOptions = {
  /** Wall-clock budget for the whole scan. */
  deadlineMs: number;
  /** Content pages this scan may read, including the homepage. */
  maxPages: number;
  /** Requests in flight at once. */
  concurrency?: number;
};

/** One key per thing fetched, so variants (another user agent) stay distinct. */
function cacheKey(url: string, variant = ""): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${variant}|${parsed.toString()}`;
  } catch {
    return `${variant}|${url}`;
  }
}

/** Builds a crawled page from a fetch result. Exported for fixture tests. */
export function toCrawledPage(url: string, result: FetchResult): CrawledPage {
  let parsed: CheerioAPI | null = null;
  return {
    url,
    finalUrl: result.finalUrl,
    status: result.status,
    ok: result.ok,
    contentType: result.contentType,
    headers: result.headers,
    html: result.body,
    bytes: result.bytes,
    ms: result.ms,
    redirects: result.redirects,
    truncated: result.truncated,
    analysis: analysePage({
      url: result.finalUrl,
      status: result.status,
      ok: result.ok,
      html: result.body,
      bytes: result.bytes,
      ms: result.ms,
    }),
    $() {
      parsed ??= load(result.body);
      return parsed;
    },
  };
}

export class Crawl {
  readonly clock: Clock;
  readonly maxPages: number;
  private readonly concurrency: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly resources = new Map<string, Promise<FetchResult | null>>();
  private readonly pageCache = new Map<string, Promise<PageOutcome>>();
  private readonly probes = new Map<string, Promise<{ status: number; ok: boolean } | null | undefined>>();
  private readonly read: CrawledPage[] = [];
  private pagesStarted = 0;
  private robotsLoad: Promise<RobotsRules | null> | null = null;
  private robotsOrigin: string | null = null;
  readonly stats: CrawlStats = { requests: 0, cacheHits: 0, skippedForTime: 0, skippedByRobots: 0, skippedForBudget: 0 };

  constructor(options: CrawlOptions) {
    this.clock = startClock(options.deadlineMs);
    this.maxPages = Math.max(1, Math.floor(options.maxPages));
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 3));
  }

  /* ── concurrency ─────────────────────────────────────────────── */

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  /** Content pages read so far, in the order they finished. */
  pages(): CrawledPage[] {
    return [...this.read];
  }

  /* ── robots.txt ──────────────────────────────────────────────── */

  /** Where robots.txt is read from. Set once the homepage's origin is known. */
  setOrigin(origin: string): void {
    this.robotsOrigin = origin;
  }

  /** The raw robots.txt response (cached), or null when there is none. */
  robotsFile(): Promise<FetchResult | null> {
    if (!this.robotsOrigin) return Promise.resolve(null);
    return this.resource(`${this.robotsOrigin}/robots.txt`, { accept: "text/plain", maxBytes: 512 * 1024, timeoutMs: 8_000 });
  }

  /** The parsed rules, or null when there is no usable file. */
  robots(): Promise<RobotsRules | null> {
    this.robotsLoad ??= this.robotsFile().then((result) => {
      if (!result || !result.ok || result.body.length === 0) return null;
      if (/text\/html|application\/xhtml/i.test(result.contentType)) return null;
      if (/^\s*(?:<!doctype html|<html|<head|<body)/i.test(result.body.slice(0, 512))) return null;
      return parseRobotsRules(result.body);
    });
    return this.robotsLoad;
  }

  private sameSite(url: string): boolean {
    if (!this.robotsOrigin) return false;
    try {
      return new URL(url).origin === this.robotsOrigin;
    } catch {
      return false;
    }
  }

  /** Whether robots.txt lets our crawler read this URL. */
  async allowed(url: string): Promise<boolean> {
    const rules = await this.robots();
    if (!rules) return true;
    try {
      const parsed = new URL(url);
      return rules.allows(parsed.pathname + parsed.search, CRAWLER_TOKEN);
    } catch {
      return false;
    }
  }

  /* ── fetching ────────────────────────────────────────────────── */

  /**
   * Any file, fetched once per (URL, user agent). Null when the request
   * failed, could not be made, or the scan is out of time. Does not count
   * towards maxPages.
   */
  resource(url: string, options: ResourceOptions = {}): Promise<FetchResult | null> {
    const key = cacheKey(url, `${options.userAgent ?? ""}|${options.accept ?? ""}`);
    const cached = this.resources.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return cached;
    }
    const pending = this.slot(async () => {
      const timeoutMs = this.clock.allow(options.timeoutMs ?? ANALYSIS_TIMEOUT_MS);
      if (timeoutMs === 0) {
        this.stats.skippedForTime += 1;
        return null;
      }
      this.stats.requests += 1;
      try {
        return await fetchGuarded(url, { ...options, timeoutMs });
      } catch {
        return null;
      }
    });
    this.resources.set(key, pending);
    return pending;
  }

  /**
   * One spelling of the homepage. Always fetched (see above) and bound by
   * the clock, but not recorded until the caller picks it with
   * `adoptHome` — a spelling that answered 404 is not the site's homepage.
   * Throws the fetch error so the caller can try the next spelling.
   */
  async homeCandidate(url: string): Promise<CrawledPage> {
    const timeoutMs = this.clock.allow(ANALYSIS_TIMEOUT_MS);
    if (timeoutMs === 0) {
      this.stats.skippedForTime += 1;
      throw new Error("out of time");
    }
    const result = await this.slot(async () => {
      this.stats.requests += 1;
      return fetchGuarded(url, { timeoutMs });
    });
    return toCrawledPage(url, result);
  }

  /** Records the chosen homepage as the scan's first page. */
  adoptHome(page: CrawledPage): void {
    this.pagesStarted = Math.max(this.pagesStarted, 1);
    this.read.unshift(page);
    const outcome: PageOutcome = { kind: "page", page };
    this.pageCache.set(cacheKey(page.url), Promise.resolve(outcome));
    this.pageCache.set(cacheKey(page.finalUrl), Promise.resolve(outcome));
    this.setOrigin(new URL(page.finalUrl).origin);
  }

  /**
   * A content page: at most once, inside maxPages, robots.txt permitting,
   * while there is time left.
   */
  page(url: string, options: { counted?: boolean } = {}): Promise<PageOutcome> {
    const key = cacheKey(url);
    const cached = this.pageCache.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return cached;
    }
    // The site's policy pages (privacy, contact, about, terms) are read
    // in addition to the plan's page allowance: `counted: false`.
    const counted = options.counted !== false;
    if (counted && this.pagesStarted >= this.maxPages) {
      this.stats.skippedForBudget += 1;
      return Promise.resolve({ kind: "skipped", url, reason: "budget" });
    }
    if (counted) this.pagesStarted += 1;

    const pending = (async (): Promise<PageOutcome> => {
      if (!(await this.allowed(url))) {
        this.stats.skippedByRobots += 1;
        if (counted) this.pagesStarted -= 1; // a page we may not read does not use the budget
        return { kind: "skipped", url, reason: "robots" };
      }
      return this.slot(async (): Promise<PageOutcome> => {
        const timeoutMs = this.clock.allow(ANALYSIS_TIMEOUT_MS);
        if (timeoutMs === 0) {
          this.stats.skippedForTime += 1;
          return { kind: "skipped", url, reason: "time" };
        }
        this.stats.requests += 1;
        try {
          const result = await fetchGuarded(url, { timeoutMs });
          if (!result.ok) return { kind: "error", url: result.finalUrl, status: result.status };
          if (!/html|xml|text\/plain/i.test(result.contentType) && result.body.length === 0) {
            return { kind: "error", url: result.finalUrl, status: result.status };
          }
          const page = toCrawledPage(url, result);
          this.read.push(page);
          return { kind: "page", page };
        } catch {
          return { kind: "error", url, status: 0 };
        }
      });
    })();
    this.pageCache.set(key, pending);
    return pending;
  }

  /**
   * A status-only check (HEAD), once per URL. `undefined` means it was not
   * attempted (out of time, or robots.txt closes it); null means it failed.
   */
  probe(url: string, timeoutMs = 6_000): Promise<{ status: number; ok: boolean } | null | undefined> {
    const key = cacheKey(url);
    const cached = this.probes.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return cached;
    }
    const pending = (async () => {
      // A page already fetched in full answers the question for free.
      const fetched = this.pageCache.get(key);
      if (fetched) {
        const outcome = await fetched;
        if (outcome.kind === "page") return { status: outcome.page.status, ok: outcome.page.ok };
        if (outcome.kind === "error" && outcome.status > 0) return { status: outcome.status, ok: false };
      }
      // A page on this site that robots.txt closes to us is not checked
      // either — a HEAD request is still a visit.
      if (this.sameSite(url) && !(await this.allowed(url))) {
        this.stats.skippedByRobots += 1;
        return undefined;
      }
      return this.slot(async () => {
        const allowed = this.clock.allow(timeoutMs);
        if (allowed === 0) {
          this.stats.skippedForTime += 1;
          return undefined;
        }
        this.stats.requests += 1;
        return probe(url, allowed);
      });
    })();
    this.probes.set(key, pending);
    return pending;
  }
}
