import { ANALYSIS_DEADLINE_MS, ANALYSIS_MAX_DEADLINE_MS, ANALYSIS_MAX_PAGES } from "@/lib/env";
import { MAX_PAGES_PER_SCAN } from "@/lib/plans";
import type { PageScore, ReportMetrics, Verdict } from "@/lib/db/types";
import { FEATURE_META, type FeatureKey } from "@/lib/plans";

import {
  checkCountFor,
  describeError,
  runChecks,
  type PolicyKind,
  type SignalName,
  type SiteSnapshot,
} from "./checks";
import { ANALYZERS } from "./analyzers";
import { classifyNiche } from "./niche";
import type { AnalyzerDef } from "./analyzers/contract";
import { runAnalyzers, type AnalyzerRun } from "./analyzers/runner";
import { Crawl } from "./crawler";
import { registrable, type PageAnalysis } from "./html";
import {
  adDensity,
  analyseStructure,
  estimateAiLikelihood,
  estimateHumanSignals,
  findDuplicates,
  originalitySignals,
  parseAdsTxt,
  parseSitemap,
} from "./signals";
import {
  describeTargetError,
  hostAlternatives,
  parseTarget,
  type Target,
} from "./target";
import {
  AnalysisFailure,
  CATEGORY_KEYS,
  CATEGORY_META,
  type AnalysisOutcome,
  type CategoryKey,
  type Finding,
  type PolicyRisk,
  type Recommendation,
  type ScoredCategory,
} from "./types";

/**
 * Orchestration: fetch a small, polite sample of the site, read it, run
 * the catalogue, and score.
 *
 * The crawl is deliberately shallow. A full crawl would be slower, ruder
 * to the site, and would not change the answer — the failures that stop
 * an AdSense application are almost always visible from the homepage
 * plus the required policy pages.
 */

const POLICY_PATTERNS: Array<{ kind: PolicyKind; path: RegExp; text: RegExp }> = [
  { kind: "privacy", path: /privacy|privasi|datenschutz/i, text: /\bprivacy\b/i },
  {
    kind: "contact",
    path: /contact|kontakt|reach-?us|get-?in-?touch/i,
    text: /\bcontact\b|get in touch|reach us|write to us/i,
  },
  { kind: "about", path: /about|who-?we-?are|our-?story/i, text: /\babout\b|who we are|our story/i },
  { kind: "terms", path: /terms|\btos\b|conditions/i, text: /\bterms\b|conditions of use/i },
  { kind: "disclaimer", path: /disclaimer/i, text: /\bdisclaimer\b/i },
  { kind: "cookies", path: /cookie/i, text: /\bcookie\b/i },
];

/**
 * Requests in flight at once across the whole scan (pages, files and link
 * checks together). Before the shared crawler this was 3 pages plus the
 * side requests running beside them; 6 overall keeps the same pace while
 * putting a hard ceiling on it.
 */
const CONCURRENCY = 6;

async function inBatches<T, R>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    const batch = items.slice(index, index + size);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
}

/**
 * A web page where a plain-text file should be. Many hosts answer a
 * missing /ads.txt or /robots.txt with their HTML "not found" page and a
 * 200 status; reading that as the file would report a record that does
 * not exist.
 */
function looksLikeHtml(contentType: string, body: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  return /^\s*(?:<!doctype html|<html|<head|<body)/i.test(body.slice(0, 512));
}

/**
 * The scan's time limit for a page allowance: the standard limit for up to
 * six pages, plus 0.6 s per page beyond that, never above
 * ANALYSIS_MAX_DEADLINE_MS (4 minutes by default). Scans run as background
 * jobs, so a long one does not hold a request open.
 */
export function scanDeadlineMs(pages: number): number {
  const extra = Math.max(0, pages - 6) * 600;
  return Math.max(ANALYSIS_DEADLINE_MS, Math.min(ANALYSIS_MAX_DEADLINE_MS, ANALYSIS_DEADLINE_MS + extra));
}

const SKIP_EXTENSIONS = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|gz|mp3|mp4|mov|avi|webm|css|js|json|xml|rss|txt|docx?|xlsx?|pptx?|exe|dmg|apk)$/i;
const SKIP_PATHS = /\/(?:wp-admin|wp-login|wp-json|feed|cart|checkout|login|logout|register|signin|signup|my-account|search)(?:\/|$)/i;

/** An internal URL worth reading as a content page. */
function contentCandidate(raw: string, host: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (registrable(url.hostname) !== host) return null;
    if (SKIP_EXTENSIONS.test(url.pathname) || SKIP_PATHS.test(url.pathname)) return null;
    if ([...url.searchParams.keys()].some((key) => /^(?:replytocom|share|print|s|q|add-to-cart)$/i.test(key))) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Reads up to `budget` content pages beyond the homepage: its links first,
 * then the links of those pages (up to three levels), then the sitemap.
 * Works in small batches and stops starting new reads once only a quarter
 * of the time limit (at least 15 s) is left, so the checks and analyzers
 * still have time to run on what was read.
 */
async function discoverContent(input: {
  crawl: Crawl;
  home: PageAnalysis;
  origin: string;
  host: string;
  budget: number;
  exclude: Set<string>;
  deadlineMs: number;
}): Promise<ReadOutcome[]> {
  const { crawl, home, host, budget } = input;
  if (budget <= 0) return [];
  // Time kept back for the checks and analyzers: a quarter of the limit,
  // at least 15 s, but never more than half of it.
  const reserve = Math.min(input.deadlineMs * 0.5, Math.max(15_000, input.deadlineMs * 0.25));
  const seen = new Set<string>([...input.exclude, home.url]);
  const results: ReadOutcome[] = [];
  let started = 0;
  const enough = () => started >= budget || crawl.clock.remaining() <= reserve;

  const take = (urls: Array<string | null | undefined>): string[] => {
    const out: string[] = [];
    for (const raw of urls) {
      const url = raw ? contentCandidate(raw, host) : null;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  };

  let frontier = take(home.links.filter((link) => link.internal).map((link) => link.absolute));
  for (let depth = 0; depth < 3 && frontier.length > 0 && !enough(); depth += 1) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length && !enough(); ) {
      const batch = frontier.slice(i, i + Math.min(12, budget - started));
      i += batch.length;
      started += batch.length;
      const outcomes = await Promise.all(
        batch.map(async (url) => {
          const outcome = await crawl.page(url);
          if (outcome.kind === "page") next.push(...take(outcome.page.analysis.links.filter((l) => l.internal).map((l) => l.absolute)));
          return outcome;
        }),
      );
      for (const outcome of outcomes) {
        if (outcome.kind === "page") results.push({ kind: "page", page: outcome.page.analysis });
        else if (outcome.kind === "error") results.push({ kind: "error", url: outcome.url, status: outcome.status });
        else started -= 1; // skipped (robots, budget, time) does not use the allowance
      }
    }
    frontier = next;
  }

  if (!enough()) {
    const sitemap = await readSitemap([`${input.origin}/sitemap.xml`, `${input.origin}/sitemap_index.xml`], host, crawl);
    const extra = take(sitemap?.urls ?? []);
    for (let i = 0; i < extra.length && !enough(); ) {
      const batch = extra.slice(i, i + Math.min(12, budget - started));
      i += batch.length;
      started += batch.length;
      for (const outcome of await Promise.all(batch.map((url) => crawl.page(url)))) {
        if (outcome.kind === "page") results.push({ kind: "page", page: outcome.page.analysis });
        else if (outcome.kind === "error") results.push({ kind: "error", url: outcome.url, status: outcome.status });
        else started -= 1;
      }
    }
  }
  return results;
}

async function readPage(url: string, crawl: Crawl, options: { counted?: boolean } = {}): Promise<ReadOutcome> {
  const outcome = await crawl.page(url, options);
  if (outcome.kind === "page") return { kind: "page", page: outcome.page.analysis };
  if (outcome.kind === "error") return { kind: "error", url: outcome.url, status: outcome.status };
  return { kind: "skipped", url: outcome.url };
}

type ReadOutcome =
  | { kind: "page"; page: PageAnalysis }
  | { kind: "error"; url: string; status: number }
  | { kind: "skipped"; url: string };

function parseRobots(text: string): {
  found: boolean;
  blocksAll: boolean;
  blocksAdsBot: boolean;
  sitemaps: string[];
} {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim());
  const sitemaps: string[] = [];
  let currentAgents: string[] = [];
  let blocksAll = false;
  let blocksAdsBot = false;

  for (const line of lines) {
    const [rawKey = "", ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (!key) continue;

    if (key === "user-agent") {
      currentAgents = currentAgents.length && value ? [...currentAgents, value.toLowerCase()] : [value.toLowerCase()];
      continue;
    }
    if (key === "sitemap" && value) {
      sitemaps.push(value);
      continue;
    }
    if (key === "disallow") {
      const blocksRoot = value === "/" || value === "/*";
      if (!blocksRoot) {
        currentAgents = currentAgents.length ? currentAgents : ["*"];
        continue;
      }
      for (const agent of currentAgents.length ? currentAgents : ["*"]) {
        if (agent === "*") blocksAll = true;
        if (agent.includes("mediapartners-google") || agent.includes("adsbot-google")) {
          blocksAdsBot = true;
        }
        if (agent === "googlebot") blocksAll = true;
      }
    }
    if (key === "allow") {
      // An explicit Allow: / for the ad crawler overrides a blanket block.
      if (value === "/" || value === "/*") {
        for (const agent of currentAgents) {
          if (agent.includes("mediapartners-google")) blocksAdsBot = false;
        }
      }
    }
    if (key !== "user-agent") currentAgents = currentAgents.length ? currentAgents : ["*"];
  }

  return { found: true, blocksAll, blocksAdsBot, sitemaps };
}

/**
 * Turns findings into a score, over only the categories that ran.
 *
 * The renormalisation matters. A Free account runs no privacy checks at
 * all, so scoring it against the shipped weights would deduct 20 points
 * for work it was never sold and hand every free user a failing grade
 * regardless of their site. Instead the weights of the categories that
 * actually produced findings are rescaled to sum to 100, so a score
 * always means "how well did you do on what we looked at".
 */
function scoreFindings(findings: Finding[]): {
  score: number;
  categories: ScoredCategory[];
  passedCount: number;
  warningCount: number;
  criticalCount: number;
} {
  const groups = CATEGORY_KEYS.map((key) => {
    // A check that could not run says nothing about the site, so it is
    // neither credit nor deduction: it is left out of the score entirely.
    const group = findings.filter((finding) => finding.category === key && finding.status !== "error");
    return {
      key,
      group,
      possible: group.reduce((sum, finding) => sum + finding.weight, 0),
    };
  }).filter((entry) => entry.possible > 0);

  const weightBasis = groups.reduce((sum, entry) => sum + CATEGORY_META[entry.key].weight, 0);

  const categories: ScoredCategory[] = [];
  let weightedTotal = 0;

  for (const { key, group, possible } of groups) {
    const meta = CATEGORY_META[key];
    // A warning is worth half credit: it is a real deduction, but not the
    // same as an outright blocker.
    const earned = group.reduce((sum, finding) => {
      if (finding.status === "pass") return sum + finding.weight;
      if (finding.status === "warn") return sum + finding.weight / 2;
      return sum;
    }, 0);
    const score = Math.round((earned / possible) * 100);
    const weight = weightBasis === 0 ? 0 : Math.round((meta.weight / weightBasis) * 100);

    categories.push({
      id: key,
      name: meta.name,
      code: meta.code,
      score,
      weight,
      passed: group.filter((finding) => finding.status === "pass").length,
      warnings: group.filter((finding) => finding.status === "warn").length,
      critical: group.filter((finding) => finding.status === "fail").length,
    });

    weightedTotal += score * meta.weight;
  }

  return {
    score: weightBasis === 0 ? 0 : Math.round(weightedTotal / weightBasis),
    categories,
    passedCount: findings.filter((finding) => finding.status === "pass").length,
    warningCount: findings.filter((finding) => finding.status === "warn").length,
    criticalCount: findings.filter((finding) => finding.status === "fail").length,
  };
}

export function verdictFor(score: number, criticalCount: number): Verdict {
  if (score < 60) return "not_ready";
  // A blocker is a blocker. A site cannot be "Ready" while something on
  // the list would get it declined, however well it scores elsewhere.
  if (criticalCount > 0) return "needs_improvement";
  return score >= 85 ? "ready" : "needs_improvement";
}

/* ══════════════════════════════════════════════════════════════════════
 *  Post-passes
 *
 *  Three of the Pro features are functions of the completed findings
 *  rather than checks in their own right, so they run here once the
 *  catalogue has finished: page-by-page scoring, the ranked policy-risk
 *  list, and the ordered remediation plan.
 * ════════════════════════════════════════════════════════════════════ */

/**
 * Scores one page on the handful of things measurable from the page alone.
 *
 * This is deliberately not the site score restricted to a page — most
 * checks (policy pages, robots, HTTPS) are properties of the site, not of
 * any single URL. What is left is enough to answer the question the
 * page-by-page view exists for: which of my pages is the weak one?
 */
function scorePage(page: PageAnalysis, aiLikelihood: number | null): PageScore {
  const tests: Array<{ ok: boolean; weight: number }> = [
    { ok: page.title.length >= 15 && page.title.length <= 65, weight: 3 },
    { ok: page.metaDescription.length >= 50, weight: 2 },
    { ok: page.headings1.length === 1, weight: 3 },
    { ok: page.wordCount >= 300, weight: 4 },
    { ok: page.wordCount >= 800, weight: 2 },
    { ok: page.headings2.length >= 1, weight: 1 },
    { ok: page.paragraphCount >= 3, weight: 1 },
    { ok: !/noindex/i.test(page.metaRobots), weight: 3 },
    { ok: page.viewport.length > 0, weight: 2 },
    {
      ok:
        page.images.length === 0 ||
        page.images.filter((image) => image.alt && image.alt.trim().length > 0).length /
          page.images.length >=
          0.8,
      weight: 2,
    },
    { ok: page.links.some((link) => link.internal), weight: 1 },
    { ok: page.ok, weight: 4 },
  ];

  const possible = tests.reduce((sum, test) => sum + test.weight, 0);
  const earned = tests.reduce((sum, test) => sum + (test.ok ? test.weight : 0), 0);
  let path = page.url;
  try {
    path = new URL(page.url).pathname || "/";
  } catch {
    /* keep the raw string */
  }

  return {
    url: page.url,
    path,
    title: page.title || "(no title)",
    status: page.status,
    words: page.wordCount,
    score: Math.round((earned / possible) * 100),
    issues: tests.filter((test) => !test.ok).length,
    aiLikelihood,
  };
}

/** The findings that, in practice, decide an AdSense review. */
const RISK_SOURCES: Array<{ ids: string[]; label: string; why: string }> = [
  {
    ids: ["pvl-privacy", "pvl-privacy-ads"],
    label: "Privacy policy",
    why: "A compliant privacy policy that mentions advertising cookies is a stated requirement, and its absence is a commonly cited reason an application is declined.",
  },
  {
    ids: ["cnt-depth", "cnt-thin", "cnt-breadth"],
    label: "Thin content",
    why: "Reviewers look for a body of substantial original pages. A small site of short posts reads as not-yet-ready however clean it is technically.",
  },
  {
    ids: ["cnt-restricted"],
    label: "Restricted content",
    why: "Content in a restricted category is a policy problem no amount of polish fixes, and it is assessed before anything else.",
  },
  {
    ids: ["cnt-duplicate-pages", "cnt-duplicate-titles", "cnt-originality", "cnt-placeholder"],
    label: "Originality",
    why: "Reused, templated or duplicated text is read as adding no value for the reader, which is the test the policy actually applies.",
  },
  {
    ids: ["tec-crawlability", "tec-robots"],
    label: "Crawler access",
    why: "If the AdSense crawler cannot read the site, the review cannot complete — this fails without ever assessing your content.",
  },
  {
    ids: ["pvl-contact", "pvl-about"],
    label: "Site identity",
    why: "Contact and about pages are how a reviewer establishes that a real, accountable publisher runs the site.",
  },
  {
    ids: ["tec-ad-density"],
    label: "Ad density",
    why: "Ad placements that outweigh the content are an explicit policy violation, and one that survives approval only until the first review.",
  },
  {
    ids: ["tec-https", "tec-http-redirect"],
    label: "HTTPS",
    why: "An insecure site undermines every other trust signal and is trivially fixable, so it reads as neglect.",
  },
  {
    ids: ["cnt-ai-estimate"],
    label: "Machine-written signals",
    why: "Policy does not forbid AI assistance, but content that reads as unedited generated prose usually fails the originality and value test that is applied.",
  },
];

function detectRisks(findings: Finding[]): PolicyRisk[] {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const risks: PolicyRisk[] = [];

  for (const source of RISK_SOURCES) {
    const hits = source.ids
      .map((id) => byId.get(id))
      .filter((finding): finding is Finding => finding !== undefined);
    // A group nobody's plan covers is simply absent, not "low risk" — we
    // did not look, so we do not have an opinion.
    if (hits.length === 0) continue;

    const failed = hits.filter((finding) => finding.status === "fail");
    const warned = hits.filter((finding) => finding.status === "warn");
    if (failed.length === 0 && warned.length === 0) continue;

    risks.push({
      label: source.label,
      level: failed.length > 0 ? "high" : warned.length > 1 ? "moderate" : "low",
      why: source.why,
    });
  }

  const order = { high: 0, moderate: 1, low: 2 };
  return risks.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * The remediation plan: findings, ordered by what to do first.
 *
 * Order is by severity, then by category weight, then by check weight, so
 * a failed privacy check outranks a warned meta description even though
 * both are real. Each entry carries the check's own fix text, which was
 * written against what we observed on this site — nothing here is
 * generated prose or a generic tip.
 */
function buildRecommendations(findings: Finding[]): Recommendation[] {
  const severity = { fail: 0, warn: 1, pass: 2, error: 3 } as const;
  const actionable = findings
    .filter((finding) => finding.status !== "pass" && finding.status !== "error" && finding.fix.length > 0)
    .sort((a, b) => {
      const bySeverity = severity[a.status] - severity[b.status];
      if (bySeverity !== 0) return bySeverity;
      const byCategory = CATEGORY_META[b.category].weight - CATEGORY_META[a.category].weight;
      if (byCategory !== 0) return byCategory;
      return b.weight - a.weight;
    });

  return actionable.slice(0, 12).map((finding, index) => ({
    rank: index + 1,
    title: finding.label,
    action: finding.fix,
    priority: finding.priority,
    from: [finding.id],
    category: CATEGORY_META[finding.category].name,
  }));
}

export type EngineStage =
  | "connect"
  | "accessibility"
  | "content"
  | "seo"
  | "navigation"
  | "mobile"
  | "privacy"
  | "technical"
  | "score"
  | "recommend";

/**
 * Reads the homepage, trying the spellings of the site that a person did
 * not type.
 *
 * A single attempt at exactly what was submitted is how a working site
 * gets reported as unreachable: plenty of hosts answer on www but not the
 * apex, or serve HTTP and redirect, or have an apex A record that points
 * nowhere. Each candidate is still screened by the guard, so widening the
 * attempts widens reach without widening what we are willing to dial.
 */
async function resolveHome(target: Target, crawl: Crawl): Promise<{ page: PageAnalysis; https: boolean }> {
  const candidates: string[] = [];
  for (const host of hostAlternatives(target.host)) {
    const secure = new URL(target.url.toString());
    secure.protocol = "https:";
    secure.hostname = host;
    candidates.push(secure.toString());
  }
  for (const host of hostAlternatives(target.host)) {
    const plain = new URL(target.url.toString());
    plain.protocol = "http:";
    plain.hostname = host;
    candidates.push(plain.toString());
  }

  let firstFailure: unknown = null;

  for (const candidate of candidates) {
    try {
      const result = await crawl.homeCandidate(candidate);
      // A 4xx/5xx still tells us the host is alive; only give up on a
      // status if another spelling might do better.
      if (!result.ok && result.status >= 400 && candidate !== candidates[candidates.length - 1]) {
        firstFailure ??= new AnalysisFailure(
          `${target.host} responded with HTTP ${result.status}.`,
          true,
        );
        continue;
      }
      crawl.adoptHome(result);
      return {
        page: result.analysis,
        https: new URL(result.finalUrl).protocol === "https:",
      };
    } catch (error) {
      firstFailure ??= error;
    }
  }

  throw firstFailure instanceof AnalysisFailure
    ? firstFailure
    : new AnalysisFailure(
        `We could not reach ${target.host}. Check that the site is online and serving pages publicly.`,
        true,
      );
}

/**
 * Audits a site with exactly the features the account holds.
 *
 * `features` is not advisory. Work outside the set is never performed:
 * the crawl budget, the extra HTTP requests and the content heuristics
 * are all switched on by the feature that pays for them. A Free scan
 * therefore costs less to serve than a Pro one, and a locked result is
 * never computed-then-hidden.
 */
export async function runAnalysis(
  rawInput: string,
  features: readonly FeatureKey[],
  options: {
    /** The analyzers to offer the gate. Defaults to the registry; tests pass their own. */
    analyzers?: readonly AnalyzerDef[];
    /**
     * The plan's pages per scan (Phase 5): content pages read, homepage
     * included; the policy pages are read in addition. Without it the
     * pre-Phase-5 budget applies (2–6 pages by plan features).
     */
    pageLimit?: number;
  } = {},
): Promise<AnalysisOutcome> {
  const parsed = parseTarget(rawInput);
  if (!parsed.ok) {
    throw new AnalysisFailure(describeTargetError(parsed.reason), true);
  }
  const target = parsed.target;
  const domain = target.domain;

  const active = new Set<FeatureKey>(features);
  const has = (feature: FeatureKey) => active.has(feature);

  // The budget is the plan's, not a constant. Free reads the homepage and
  // little else; Basic reads enough to find the policy pages; Pro's deep
  // page check is precisely the promise of a wider crawl, so it gets one.
  const ceiling = Math.max(2, ANALYSIS_MAX_PAGES);
  const planLimited = typeof options.pageLimit === "number" && Number.isFinite(options.pageLimit);
  const allowance = planLimited
    ? Math.max(1, Math.min(MAX_PAGES_PER_SCAN, Math.floor(options.pageLimit!)))
    : has("deep_ai_page_check")
      ? ceiling
      : has("advanced_page_check")
        ? Math.max(2, Math.ceil(ceiling / 2))
        : 2;
  const deadlineMs = planLimited ? scanDeadlineMs(allowance) : ANALYSIS_DEADLINE_MS;

  // One crawl serves every check and analyzer in this scan.
  const crawl = new Crawl({ deadlineMs, maxPages: allowance, concurrency: CONCURRENCY });
  const timedProbe = (url: string, ms: number) => crawl.probe(url, ms);

  const { page: home, https } = await resolveHome(target, crawl);

  const origin = new URL(home.url).origin;
  const host = registrable(new URL(home.url).hostname);

  // ── Discover the required pages from the homepage's own links ─────
  const policyLinks: Partial<Record<PolicyKind, { url: string; label: string }>> = {};
  for (const link of home.links) {
    if (!link.absolute || !link.internal) continue;
    let path: string;
    try {
      path = new URL(link.absolute).pathname;
    } catch {
      continue;
    }
    for (const pattern of POLICY_PATTERNS) {
      if (policyLinks[pattern.kind]) continue;
      if (pattern.path.test(path) || pattern.text.test(link.text)) {
        policyLinks[pattern.kind] = {
          url: link.absolute,
          label: link.text || path,
        };
      }
    }
  }

  const internalUrls = [
    ...new Set(
      home.links
        .filter((link) => link.internal && link.absolute)
        .map((link) => link.absolute as string),
    ),
  ];

  // ── Choose what else to read, inside the page budget ─────────────
  const budget = allowance - 1;

  const priority: string[] = [];
  if (has("adsense_policy_check")) {
    for (const kind of ["privacy", "contact", "about", "terms"] as PolicyKind[]) {
      const hit = policyLinks[kind];
      if (hit && !priority.includes(hit.url)) priority.push(hit.url);
    }
  }
  const policyUrlSet = new Set(priority);
  const contentCandidates = internalUrls.filter(
    (url) => !policyUrlSet.has(url) && url !== home.url,
  );

  const toFetch = planLimited
    ? []
    : [
        ...priority.slice(0, Math.max(1, budget - 2)),
        ...contentCandidates.slice(0, Math.max(0, budget - Math.min(priority.length, budget - 2))),
      ].slice(0, budget);

  // Phase 5: the policy pages are read outside the allowance, and content
  // pages are discovered breadth-first (homepage links, then theirs, then
  // the sitemap) until the plan's pages-per-scan is reached, leaving time
  // for the analysis itself.
  const planReads: Promise<ReadOutcome[]> = planLimited
    ? Promise.all([
        Promise.all(priority.map((url) => readPage(url, crawl, { counted: false }))),
        discoverContent({ crawl, home, origin, host, budget, exclude: new Set([...priority, home.url]), deadlineMs }),
      ]).then(([policy, content]) => [...policy, ...content])
    : Promise.resolve([]);

  // robots.txt is read for its own check, and again as an input to the
  // crawlability verdict and to find the sitemap — any one of the three
  // features justifies the request, and one request serves all of them.
  const wantsRobots =
    has("robots_check") || has("crawlability_check") || has("sitemap_analysis");

  const [extraPages, robotsResult, sitemapHit, httpProbe, linkChecks, adsTxtResult] =
    await Promise.all([
      Promise.all(toFetch.map((url) => readPage(url, crawl))).then(async (legacy) => [...legacy, ...(await planReads)]),
      (async () => {
        if (!wantsRobots) return null;
        // The crawler has already read robots.txt for its own manners;
        // this reuses that one response.
        const result = await crawl.robotsFile();
        if (!result || !result.ok || result.body.length === 0 || looksLikeHtml(result.contentType, result.body)) return null;
        return parseRobots(result.body.slice(0, 64 * 1024));
      })(),
      (async () => {
        if (!has("sitemap_analysis")) return false;
        // Read (not just HEAD) so the sitemap step below reuses this response.
        for (const path of ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"]) {
          const found = await crawl.resource(`${origin}${path}`, SITEMAP_FETCH);
          if (found?.ok) return true;
        }
        return false;
      })(),
      (async () => {
        if (!has("https_check")) return null;
        if (!https) return false;
        const result = await crawl.resource(`http://${host}/`, { maxBytes: 32 * 1024, timeoutMs: 8_000 });
        return result ? new URL(result.finalUrl).protocol === "https:" : null;
      })(),
      (async (): Promise<{ sampled: number; broken: Array<{ url: string; status: number }> }> => {
        if (!has("advanced_page_check")) return { sampled: 0, broken: [] };
        const sample = internalUrls.filter((url) => url !== home.url).slice(0, 8);
        const results = await inBatches(sample, 4, async (url) => {
          const found = await timedProbe(url, 6_000);
          return { url, status: found?.status ?? 0, ok: found?.ok ?? true, skipped: found === undefined };
        });
        return {
          // A link we ran out of time to test was not sampled.
          sampled: results.filter((entry) => !entry.skipped).length,
          broken: results
            .filter((entry) => !entry.ok && entry.status >= 400)
            .map((entry) => ({ url: entry.url, status: entry.status })),
        };
      })(),
      (async () => {
        if (!has("ad_density_analysis")) return null;
        const result = await crawl.resource(`${origin}/ads.txt`, { accept: "text/plain", maxBytes: 64 * 1024, timeoutMs: 8_000 });
        if (!result) return crawl.clock.partial() ? null : parseAdsTxt("");
        if (!result.ok || looksLikeHtml(result.contentType, result.body)) return parseAdsTxt("");
        return parseAdsTxt(result.body);
      })(),
    ]);

  // Unreadable pages are recorded as evidence for the technical check but
  // kept out of the content averages — a 404 should not drag down the
  // measured word count of the pages that do exist.
  const pages = [
    home,
    ...extraPages.flatMap((outcome) => (outcome.kind === "page" ? [outcome.page] : [])),
  ];
  const failedPages = [
    ...extraPages.flatMap((outcome) =>
      outcome.kind === "error" ? [{ url: outcome.url, status: outcome.status }] : [],
    ),
    ...(home.ok ? [] : [{ url: home.url, status: home.status }]),
  ];

  const policyPages: Partial<Record<PolicyKind, PageAnalysis>> = {};
  for (const [kind, hit] of Object.entries(policyLinks) as Array<
    [PolicyKind, { url: string; label: string }]
  >) {
    const match = pages.find((page) => page.url === hit.url);
    if (match) policyPages[kind] = match;
  }

  const sitemapFound = sitemapHit || (robotsResult?.sitemaps.length ?? 0) > 0;

  // ── Second wave: reading the sitemap, which we only know about now ──
  let sitemapReport: Awaited<ReturnType<typeof readSitemap>> = null;
  let sitemapUnreachable: string[] = [];
  if (has("sitemap_analysis")) {
    const addresses = [
      ...(robotsResult?.sitemaps ?? []),
      `${origin}/sitemap.xml`,
      `${origin}/sitemap_index.xml`,
    ];
    sitemapReport = await readSitemap(addresses, host, crawl);
    if (sitemapReport && sitemapReport.urls.length > 0) {
      const sample = sitemapReport.urls.slice(0, 6);
      const probes = await inBatches(sample, 3, async (url) => {
        const found = await timedProbe(url, 6_000);
        return { url, ok: found?.ok ?? false, skipped: found === undefined };
      });
      // Out of time is not "unreachable".
      sitemapUnreachable = probes.filter((entry) => !entry.ok && !entry.skipped).map((entry) => entry.url);
    }
  }

  /* ── the paid content signals ────────────────────────────────────
   *
   * Each is computed only when its feature is present. `deep_ai_page_check`
   * widens the AI estimate from the homepage to the whole crawl, which is
   * exactly what the plan card claims it does.
   */
  const readable = pages.filter((page) => page.ok && page.wordCount > 0);
  const corpus = (has("deep_ai_page_check") ? readable : readable.slice(0, 1))
    .map((page) => page.text)
    .join("\n\n");

  // Each calculation is isolated: one that throws is recorded, and only
  // the checks that read it report "error" — the rest of the scan goes on.
  const signalErrors: SignalName[] = [];
  const safely = <T,>(name: SignalName, enabled: boolean, compute: () => T): T | null => {
    if (!enabled) return null;
    try {
      return compute();
    } catch (error) {
      console.error(`[analysis] ${name} calculation failed: ${describeError(error)}`);
      signalErrors.push(name);
      return null;
    }
  };

  const duplicates = safely("duplicates", has("duplicate_content_check"), () => findDuplicates(readable));
  const ai = safely("ai", has("ai_content_check"), () => estimateAiLikelihood(corpus));
  const human = safely("human", has("ai_human_content_check"), () => estimateHumanSignals(readable));
  const originality = safely("originality", has("originality_check"), () =>
    originalitySignals(readable, duplicates?.share ?? 0),
  );
  const ads = safely("ads", has("ad_density_analysis"), () => adDensity(readable));
  const structure = safely("structure", has("site_structure_analysis"), () =>
    analyseStructure(readable, internalUrls),
  );

  const snapshot: SiteSnapshot = {
    input: rawInput,
    origin,
    domain,
    home,
    pages,
    failedPages,
    policyLinks,
    policyPages,
    robots: robotsResult,
    sitemapFound,
    https,
    httpRedirectsToHttps: httpProbe,
    brokenLinks: linkChecks.broken,
    sampledLinks: linkChecks.sampled,
    hasMailto: home.links.some((link) => /^mailto:/i.test(link.href)),
    hasContactForm: pages.some((page) => page.hasForm),
    internalUrls,
    ai,
    human,
    originality,
    duplicates,
    ads,
    adsTxt: adsTxtResult,
    structure,
    sitemap: sitemapReport,
    sitemapUnreachable,
    signalErrors,
  };

  // ── Analyzers, over the same crawl ───────────────────────────────
  // Only those whose feature this account holds are even called.
  const homePage = crawl.pages()[0];
  let analyzerRun: AnalyzerRun = { findings: [], featureVector: {}, ran: [] };
  if (homePage) {
    try {
      analyzerRun = await runAnalyzers({
        defs: options.analyzers ?? ANALYZERS,
        features: active as ReadonlySet<string>,
        crawl,
        site: { origin, domain, host, home: homePage, https, policyLinks, internalUrls, snapshot },
      });
    } catch (error) {
      // The runner isolates each analyzer; this is the last line of defence.
      console.error(`[analysis] analyzers failed: ${describeError(error)}`);
    }
  }

  // Content pages linked from what was read but not read themselves — a
  // lower bound on what a larger page allowance would reach. Counted from
  // links already in hand; nothing extra is fetched or run for it.
  let unreadPages: number | undefined;
  if (planLimited) {
    const read = new Set(crawl.pages().map((page) => page.analysis.url.replace(/#.*$/, "")));
    const unread = new Set<string>();
    for (const page of crawl.pages()) {
      for (const link of page.analysis.links) {
        if (!link.internal || !link.absolute) continue;
        const url = contentCandidate(link.absolute, host);
        if (url && !read.has(url) && !policyUrlSet.has(link.absolute) && !policyUrlSet.has(url)) unread.add(url);
      }
    }
    unreadPages = unread.size;
  }

  return composeOutcome(snapshot, features, {
    unreadPages,
    pagesFetched: crawl.pages().length,
    pageUrls: crawl.pages().map((page) => page.analysis.url),
    partial: crawl.clock.partial(),
    extraFindings: analyzerRun.findings,
    featureVector: analyzerRun.featureVector,
  });
}

/**
 * Runs the catalogue over a finished snapshot and assembles the report.
 *
 * Split out so the offline demo path goes through exactly the same
 * scoring, the same metrics and the same locked-feature list. Two
 * codepaths producing two slightly different report shapes is how a demo
 * stops being a faithful preview of the real thing.
 */
/** A post-pass that fails is left out of the report rather than failing it. */
function guarded<T extends object>(name: string, build: () => T): T | Record<string, never> {
  try {
    return build();
  } catch (error) {
    console.error(`[analysis] ${name} failed: ${describeError(error)}`);
    return {};
  }
}

export function composeOutcome(
  snapshot: SiteSnapshot,
  features: readonly FeatureKey[],
  options: {
    pagesFetched: number;
    pageUrls: string[];
    partial?: boolean;
    /** Report lines from analyzers, added after the built-in checks. */
    extraFindings?: Finding[];
    featureVector?: Record<string, number>;
    /** Content pages found but not read within the plan's page allowance. */
    unreadPages?: number;
  },
): AnalysisOutcome {
  const active = new Set<FeatureKey>(features);
  const has = (feature: FeatureKey) => active.has(feature);

  const findings = [...runChecks(snapshot, features), ...(options.extraFindings ?? [])];
  const scored = scoreFindings(findings);

  const readable = snapshot.pages.filter((page) => page.ok && page.wordCount > 0);
  const { ai, human, originality, duplicates, ads, structure, sitemap } = snapshot;

  // ── Per-page scores, for the Pro page-by-page view ────────────────
  const pageScores: PageScore[] = has("page_by_page_analysis")
    ? snapshot.pages.flatMap((page) => {
        // One page that cannot be scored is left out, not the whole list.
        try {
          let aiScore: number | null = null;
          if (has("deep_ai_page_check") && page.wordCount >= 200) {
            try {
              aiScore = estimateAiLikelihood(page.text).score;
            } catch (error) {
              console.error(`[analysis] page AI estimate failed: ${describeError(error)}`);
            }
          }
          return [scorePage(page, aiScore)];
        } catch (error) {
          console.error(`[analysis] page score failed: ${describeError(error)}`);
          return [];
        }
      })
    : [];

  const totalWords = readable.reduce((sum, page) => sum + page.wordCount, 0);
  const metrics: ReportMetrics = {
    ...(options.partial ? { partial: true } : {}),
    ...(typeof options.unreadPages === "number" ? { unreadPages: options.unreadPages } : {}),
    totalWords,
    averageWords: readable.length > 0 ? Math.round(totalWords / readable.length) : 0,
    ...(ai
      ? { aiLikelihood: ai.score, aiBand: ai.band, aiReliable: ai.reliable }
      : {}),
    ...(human ? { humanSignalScore: human.score } : {}),
    ...(originality ? { originality: originality.score } : {}),
    ...(duplicates
      ? { duplicatePairs: duplicates.pairs.length, duplicateShare: duplicates.share }
      : {}),
    ...(ads ? { adDensity: ads.perThousandWords, adSlots: ads.slots } : {}),
    ...(sitemap ? { sitemapUrls: sitemap.urls.length } : {}),
    ...(structure
      ? {
          maxDepth: structure.maxDepth,
          averageDepth: structure.averageDepth,
          orphanPages: structure.orphans.length,
        }
      : {}),
    ...(has("advanced_page_check") ? { brokenLinks: snapshot.brokenLinks.length } : {}),
    ...guarded("niche", () => {
      const niche = classifyNiche(
        readable.map((page) => ({ title: page.title, headings: [...page.headings1, ...page.headings2], text: page.text })),
      );
      return { niche: niche.niche, nicheConfidence: niche.confidence };
    }),
    ...(has("policy_risk_detection")
      ? guarded("risk ranking", () => {
          const risks = detectRisks(findings);
          const level = risks.some((risk) => risk.level === "high")
            ? "high"
            : risks.filter((risk) => risk.level === "moderate").length > 1
              ? "elevated"
              : risks.length > 0
                ? "moderate"
                : "low";
          return { risks, riskLevel: level as ReportMetrics["riskLevel"] };
        })
      : {}),
    ...(has("ai_recommendations")
      ? guarded("recommendations", () => ({ recommendations: buildRecommendations(findings) }))
      : {}),
  };

  // What a higher plan would have added, for the upgrade prompts. Only
  // features that change the report are worth naming here — offering to
  // sell somebody priority support from inside a scan result is noise.
  const locked = (Object.keys(FEATURE_META) as FeatureKey[]).filter(
    (feature) =>
      !active.has(feature) && feature !== "priority_support" && feature !== "pdf_export",
  );

  return {
    score: scored.score,
    verdict: verdictFor(scored.score, scored.criticalCount),
    categories: scored.categories,
    findings,
    passedCount: scored.passedCount,
    warningCount: scored.warningCount,
    criticalCount: scored.criticalCount,
    pagesFetched: options.pagesFetched,
    pageUrls: options.pageUrls,
    features: [...active],
    locked,
    pages: pageScores,
    metrics,
    checksRun: findings.length,
    featureVector: options.featureVector ?? {},
  };
}

/**
 * Fetches the first sitemap that answers, following one level of index.
 *
 * One level is deliberate: a sitemap index of fifty children would be
 * fifty more requests for a number we already have well enough, and the
 * check text says plainly that we read the index rather than every child.
 */
const SITEMAP_FETCH = { accept: "application/xml,text/xml", maxBytes: 512 * 1024, timeoutMs: 10_000 };

async function readSitemap(
  addresses: string[],
  host: string,
  crawl: Crawl,
): Promise<ReturnType<typeof parseSitemap> | null> {
  const tried = new Set<string>();
  const xml = SITEMAP_FETCH;
  for (const address of addresses) {
    if (tried.has(address)) continue;
    tried.add(address);
    if (crawl.clock.remaining() < 500) return null;
    const result = await crawl.resource(address, xml);
    if (!result || !result.ok || result.body.length === 0) continue;
    try {
      const report = parseSitemap(result.body, host);
      if (report.isIndex && report.children.length > 0 && report.urls.length === 0) {
        const child = report.children[0];
        if (child) {
          const nested = await crawl.resource(child, xml);
          if (nested && nested.ok && nested.body.length > 0) {
            const inner = parseSitemap(nested.body, host);
            return { ...report, urls: inner.urls, offDomain: inner.offDomain };
          }
        }
      }
      return report;
    } catch {
      continue;
    }
  }
  return null;
}

export { checkCountFor, scoreFindings };
export type { CategoryKey };
