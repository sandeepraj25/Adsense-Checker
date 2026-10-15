import type { IssuePriority } from "@/lib/db/types";

import { describeError } from "../checks";
import type { Crawl, CrawledPage } from "../crawler";
import type { CategoryKey, Finding } from "../types";
import type { AnalyzerCategory } from "./catalog";
import type {
  AnalyzerContext,
  AnalyzerDef,
  AnalyzerFinding,
  AnalyzerResult,
  CheckedResult,
  SiteMeta,
} from "./contract";

/**
 * Runs the analyzers an account holds, over one shared crawl.
 *
 *   1. Gate first: an analyzer whose feature is not in the set is never
 *      called, so it costs no CPU and no request.
 *   2. Every call is wrapped: a throw, a timeout or a malformed result
 *      becomes an "error" result for that analyzer alone, the cause is
 *      logged, and the scan goes on.
 *   3. Results are validated and normalised into report lines (Findings)
 *      plus a flat numeric feature vector for the prediction model.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FINDINGS = 50;
const STATUSES = new Set(["pass", "warn", "fail", "error"]);
const FEATURE_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export const ANALYZER_ERROR_DETAIL =
  "This check couldn't run because of an error on our side. It says nothing about your site and is left out of the score.";
const OUT_OF_TIME_DETAIL =
  "This check couldn't run because the scan reached its time limit. It says nothing about your site and is left out of the score.";

/** Where an analyzer's line is scored among the existing report categories. */
const SCORE_CATEGORY: Record<AnalyzerCategory, CategoryKey> = {
  content: "content",
  policy: "privacy",
  trust: "privacy",
  technical: "technical",
  smart: "technical", // shown, never scored (weight 0, see below)
};

function errorResult(internalError: string, detail = ANALYZER_ERROR_DETAIL): CheckedResult {
  return { status: "error", findings: [], recommendation: "", features: {}, summary: detail, internalError };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks an analyzer's raw return value against the contract. Anything
 * that does not fit becomes an "error" result rather than a half-trusted
 * report line.
 */
export function validateResult(raw: unknown): CheckedResult {
  if (!raw || typeof raw !== "object") return errorResult("result is not an object");
  const result = raw as Partial<AnalyzerResult>;
  if (typeof result.status !== "string" || !STATUSES.has(result.status)) return errorResult(`invalid status ${String(result.status)}`);
  if (!Array.isArray(result.findings)) return errorResult("findings is not an array");
  if (typeof result.recommendation !== "string") return errorResult("recommendation is not a string");

  const findings: AnalyzerFinding[] = [];
  for (const item of result.findings.slice(0, MAX_FINDINGS)) {
    const message = text((item as AnalyzerFinding | null)?.message, 600);
    if (!message) return errorResult("a finding has no message");
    const evidence = text((item as AnalyzerFinding).evidence, 600);
    const pageUrl = httpUrl((item as AnalyzerFinding).pageUrl);
    findings.push({ message, ...(evidence ? { evidence } : {}), ...(pageUrl ? { pageUrl } : {}) });
  }

  const features: Record<string, number> = {};
  if (result.features !== undefined) {
    if (!result.features || typeof result.features !== "object" || Array.isArray(result.features)) {
      return errorResult("features is not an object");
    }
    for (const [name, value] of Object.entries(result.features).slice(0, 40)) {
      if (!FEATURE_NAME.test(name)) return errorResult(`bad feature name ${name.slice(0, 40)}`);
      if (typeof value !== "number" || !Number.isFinite(value)) return errorResult(`feature ${name} is not a finite number`);
      features[name] = value;
    }
  }

  let score: number | undefined;
  if (result.score !== undefined) {
    if (typeof result.score !== "number" || !Number.isFinite(result.score)) return errorResult("score is not a finite number");
    score = Math.round(Math.min(100, Math.max(0, result.score)));
  }

  const confidence = result.confidence && ["high", "medium", "low"].includes(result.confidence) ? result.confidence : undefined;
  const summary = text(result.summary, 300) ?? undefined;
  return {
    status: result.status,
    findings,
    recommendation: text(result.recommendation, 1000) ?? "",
    features,
    ...(score !== undefined ? { score } : {}),
    ...(summary ? { summary } : {}),
    ...(confidence ? { confidence } : {}),
  };
}

/** One sentence for several pages: shared wording when they agree, else a count. */
function combinedSummary(usable: Array<{ result: CheckedResult }>): string | undefined {
  const summaries = [...new Set(usable.map((entry) => entry.result.summary).filter((s): s is string => Boolean(s)))];
  if (usable.length === 1) return usable[0]?.result.summary;
  const failing = usable.filter((entry) => entry.result.status !== "pass").length;
  if (failing === 0) {
    return summaries.length === 1 ? `${summaries[0]} (${usable.length} pages checked)` : `Checked ${usable.length} pages: no problems found.`;
  }
  return undefined; // the first finding speaks for a line that needs attention
}

/** The default way per-page results become one line: worst status wins. */
export function combinePageResults(results: Array<{ page: CrawledPage; result: CheckedResult }>): CheckedResult {
  const usable = results.filter((entry) => entry.result.status !== "error");
  if (usable.length === 0) return results[0]?.result ?? errorResult("no pages to analyse");
  const rank = { fail: 0, warn: 1, pass: 2, error: 3 } as const;
  const worst = usable.reduce((a, b) => (rank[b.result.status] < rank[a.result.status] ? b : a));
  const scores = usable.flatMap((entry) => (entry.result.score === undefined ? [] : [entry.result.score]));
  const featureSums = new Map<string, { sum: number; n: number }>();
  for (const { result } of usable) {
    for (const [name, value] of Object.entries(result.features)) {
      const entry = featureSums.get(name) ?? { sum: 0, n: 0 };
      featureSums.set(name, { sum: entry.sum + value, n: entry.n + 1 });
    }
  }
  return {
    status: worst.result.status,
    findings: usable
      .flatMap(({ page, result }) => result.findings.map((f) => ({ ...f, pageUrl: f.pageUrl ?? page.finalUrl })))
      .slice(0, MAX_FINDINGS),
    recommendation: worst.result.recommendation,
    features: Object.fromEntries([...featureSums].map(([name, { sum, n }]) => [name, sum / n])),
    ...(scores.length > 0 ? { score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) } : {}),
    summary: combinedSummary(usable),
  };
}

async function callWithTimeout(def: AnalyzerDef, ctx: AnalyzerContext, crawl: Crawl): Promise<CheckedResult> {
  const budget = Math.min(def.timeoutMs ?? DEFAULT_TIMEOUT_MS, crawl.clock.remaining());
  if (budget < 250) return errorResult("out of time", OUT_OF_TIME_DETAIL);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => def.run(ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${budget} ms`)), budget);
      }),
    ]);
    return validateResult(raw);
  } catch (error) {
    return errorResult(describeError(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function contextFor(page: CrawledPage, crawl: Crawl, site: SiteMeta): AnalyzerContext {
  return {
    url: page.finalUrl,
    html: page.html,
    $: page.$(),
    headers: page.headers,
    statusCode: page.status,
    page,
    analysis: page.analysis,
    crawledPages: crawl.pages(),
    siteMeta: site,
    robots: () => crawl.robots(),
    fetchResource: (url, options) => crawl.resource(url, options),
    probe: (url) => crawl.probe(url),
    remainingMs: () => crawl.clock.remaining(),
    now: Date.now(),
  };
}

async function runOne(def: AnalyzerDef, crawl: Crawl, site: SiteMeta): Promise<CheckedResult> {
  try {
    if (def.scope === "site") return await callWithTimeout(def, contextFor(site.home, crawl, site), crawl);
    const all = crawl.pages().filter((page) => page.ok);
    const pages = def.pages ? def.pages(all, site) : all;
    if (pages.length === 0) {
      return { status: "warn", findings: [], recommendation: "", features: {}, summary: "There were no readable pages to check." };
    }
    const results: Array<{ page: CrawledPage; result: CheckedResult }> = [];
    for (const page of pages) results.push({ page, result: await callWithTimeout(def, contextFor(page, crawl, site), crawl) });
    if (def.combine) {
      try {
        return validateResult(def.combine(results.map(({ page, result }) => ({ page, result }))));
      } catch (error) {
        return errorResult(`combine: ${describeError(error)}`);
      }
    }
    return combinePageResults(results);
  } catch (error) {
    return errorResult(describeError(error));
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** One analyzer result as a report line. */
export function toFinding(def: AnalyzerDef, result: CheckedResult): Finding {
  const weight = def.category === "smart" ? 0 : (def.weight ?? 3);
  const priority: IssuePriority =
    result.status === "fail" ? (def.failPriority ?? "medium") : result.status === "warn" ? (def.warnPriority ?? "low") : "low";
  const first = result.findings[0];
  const detail =
    result.status === "error"
      ? (result.summary ?? ANALYZER_ERROR_DETAIL)
      : (result.summary ??
        (result.status === "pass"
          ? "No problems found."
          : first
            ? `${first.message}${result.findings.length > 1 ? ` (and ${result.findings.length - 1} more)` : ""}`
            : "Something here needs attention."));
  // Compact evidence for the existing report card: the proof (or, without
  // one, the finding itself) and where it was seen. Full findings are kept
  // in `analyzer.items`.
  const evidence = result.findings
    .slice(0, 3)
    .map((f) => `${f.evidence ? `“${f.evidence.slice(0, 140)}”` : f.message}${f.pageUrl ? ` (${shortUrl(f.pageUrl)})` : ""}`)
    .join("\n");
  return {
    id: def.key,
    category: SCORE_CATEGORY[def.category],
    label: def.name,
    status: result.status,
    detail,
    fix: result.status === "pass" || result.status === "error" ? "" : result.recommendation,
    priority,
    weight,
    feature: def.key as Finding["feature"],
    ...(evidence ? { evidence } : {}),
    analyzer: {
      category: def.category,
      items: result.findings,
      ...(result.score !== undefined ? { score: result.score } : {}),
      ...(result.confidence ? { confidence: result.confidence } : {}),
    },
  };
}

export type AnalyzerRun = {
  findings: Finding[];
  /** `<key>.<name>` → value, plus `<key>.status` (1 pass, 0.5 warn, 0 fail). */
  featureVector: Record<string, number>;
  /** Keys that were actually run (the gate's output), for tests and logs. */
  ran: string[];
};

export async function runAnalyzers(input: {
  defs: readonly AnalyzerDef[];
  features: ReadonlySet<string>;
  crawl: Crawl;
  site: SiteMeta;
}): Promise<AnalyzerRun> {
  // The gate: nothing below is reached for a feature the account lacks.
  const enabled = input.defs.filter((def) => input.features.has(def.key));
  const results = await Promise.all(enabled.map((def) => runOne(def, input.crawl, input.site)));

  const featureVector: Record<string, number> = {};
  const findings = enabled.map((def, index) => {
    const result = results[index] ?? errorResult("missing result");
    if (result.internalError) console.error(`[analysis] analyzer ${def.key} failed: ${result.internalError}`);
    if (result.status !== "error") {
      featureVector[`${def.key}.status`] = result.status === "pass" ? 1 : result.status === "warn" ? 0.5 : 0;
      for (const [name, value] of Object.entries(result.features)) featureVector[`${def.key}.${name}`] = value;
    }
    return toFinding(def, result);
  });
  return { findings, featureVector, ran: enabled.map((def) => def.key) };
}
