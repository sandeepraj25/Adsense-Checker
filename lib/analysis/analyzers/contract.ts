import type { CheerioAPI } from "cheerio";

import type { IssuePriority } from "@/lib/db/types";

import type { PolicyKind, SiteSnapshot } from "../checks";
import type { CrawledPage, ResourceOptions } from "../crawler";
import type { FetchResult } from "../fetcher";
import type { PageAnalysis } from "../html";
import type { RobotsRules } from "../robots";
import type { AnalyzerCategory, AnalyzerScope } from "./catalog";

/**
 * The contract every analyzer follows.
 *
 * One analyzer = one feature key = one file in
 * lib/analysis/analyzers/<category>/<key>.ts. It never fetches on its own:
 * everything it reads comes from the shared crawl through `ctx`, which
 * fetches each thing once per scan, inside the scan's time limit and the
 * address screening. The runner (./runner.ts) only calls an analyzer
 * whose feature the account holds, wraps it so a throw or a bad result
 * becomes an "error" result, and validates whatever it returns.
 */

export type AnalyzerStatus = "pass" | "warn" | "fail" | "error";

export type AnalyzerFinding = {
  /** Plain English: what we saw. */
  message: string;
  /** The text, tag, header or number that shows it. */
  evidence?: string;
  /** The page it was seen on, when it belongs to one. */
  pageUrl?: string;
};

export type AnalyzerResult = {
  status: AnalyzerStatus;
  /** 0–100, higher is better. Optional: not every analyzer is a score. */
  score?: number;
  /** One sentence for the report line. Derived from the findings when omitted. */
  summary?: string;
  findings: AnalyzerFinding[];
  /** What to do about it, in plain English. Empty on a pass. */
  recommendation: string;
  /**
   * Numbers for the prediction model (Phase 3). Names are short
   * snake_case; the runner prefixes them with the analyzer key.
   */
  features?: Record<string, number>;
  /** How sure the analyzer is, when that matters to the reader. */
  confidence?: "high" | "medium" | "low";
};

/** Site-wide facts every analyzer may read. Nothing here costs a request. */
export type SiteMeta = {
  origin: string;
  domain: string;
  /** The registrable host, without www. */
  host: string;
  home: CrawledPage;
  https: boolean;
  policyLinks: Partial<Record<PolicyKind, { url: string; label: string }>>;
  internalUrls: string[];
  /** The existing snapshot, for analyzers that build on an existing reading. */
  snapshot: SiteSnapshot;
};

export type AnalyzerContext = {
  /** The page under analysis (page scope) or the homepage (site scope). */
  url: string;
  html: string;
  $: CheerioAPI;
  headers: Record<string, string>;
  statusCode: number;
  page: CrawledPage;
  analysis: PageAnalysis;
  /** Every content page this scan read, homepage first. */
  crawledPages: CrawledPage[];
  siteMeta: SiteMeta;
  /** robots.txt rules, when the site has a usable file. */
  robots(): Promise<RobotsRules | null>;
  /**
   * Any file from the shared crawl: fetched once per scan per URL and
   * user agent, screened, size-capped and inside the time limit. Null when
   * it failed or time ran out.
   */
  fetchResource(url: string, options?: ResourceOptions): Promise<FetchResult | null>;
  /** A status-only check. undefined = skipped for time, null = failed. */
  probe(url: string): Promise<{ status: number; ok: boolean } | null | undefined>;
  /** Milliseconds left in the scan's time budget. */
  remainingMs(): number;
  /** "Now" for this scan (ms since epoch) — read this, not Date.now(), so tests can fix it. */
  now: number;
};

export type AnalyzerDef = {
  key: string;
  name: string;
  category: AnalyzerCategory;
  /** Only seeds the default mapping; the admin decides after that. */
  defaultPlan: "free" | "basic" | "pro";
  scope: AnalyzerScope;
  /** Relative weight in the score (0 = shown but not scored). Default 3. */
  weight?: number;
  failPriority?: IssuePriority;
  warnPriority?: IssuePriority;
  /** Upper bound for one run, in ms (default 15 s, never past the scan's deadline). */
  timeoutMs?: number;
  /** Page scope only: which pages to run on. Default: every content page read. */
  pages?: (pages: CrawledPage[], site: SiteMeta) => CrawledPage[];
  run: (ctx: AnalyzerContext) => Promise<AnalyzerResult> | AnalyzerResult;
  /**
   * Page scope only: how per-page results become one report line. The
   * default takes the worst status, averages scores, keeps every finding
   * with its page URL, and averages each numeric feature.
   */
  combine?: (results: Array<{ page: CrawledPage; result: AnalyzerResult }>) => AnalyzerResult;
};

/** A validated result, ready to become a report line. */
export type CheckedResult = Required<Pick<AnalyzerResult, "status" | "findings" | "recommendation">> & {
  score?: number;
  summary?: string;
  features: Record<string, number>;
  confidence?: AnalyzerResult["confidence"];
  /** Internal only — logged, never shown. */
  internalError?: string;
};
