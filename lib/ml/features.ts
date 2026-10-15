import type { AnalysisOutcome } from "@/lib/analysis/types";

/**
 * The numeric description of one scan that the prediction model learns
 * from — and the only thing about a scan it ever sees.
 *
 * Names are stable and versioned (FEATURE_SCHEMA). A name never changes
 * meaning: when a signal changes meaning it gets a new name, and a change
 * to how names are built bumps the schema, so a model only ever compares
 * like with like.
 *
 *   core.*     overall score, pass/warn/fail counts, pages read, partial
 *   cat.*      the six category scores (0–100)
 *   check.*    each built-in check: 1 pass, 0.5 warn, 0 fail
 *   metric.*   headline numbers (words, duplicate share, ad density, …)
 *   az.*       analyzer signals: `az.<key>.status` and `az.<key>.<name>`
 *
 * A check or analyzer the plan did not run is simply absent — "missing",
 * not zero. Training fills a missing value with that feature's training
 * average, so a Free scan is not read as "failed every Pro check".
 *
 * No text, URL, email or other personal data is ever part of a vector.
 */

export const FEATURE_SCHEMA = "fs-1";

/** Upper bounds that keep one odd scan from bloating the table. */
const MAX_FEATURES = 800;
const MAX_ABS = 1e9;
const NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

export type FeatureVector = Record<string, number>;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

const STATUS_VALUE: Record<string, number> = { pass: 1, warn: 0.5, fail: 0 };

const METRICS = [
  "totalWords",
  "averageWords",
  "aiLikelihood",
  "humanSignalScore",
  "originality",
  "duplicatePairs",
  "duplicateShare",
  "adDensity",
  "adSlots",
  "sitemapUrls",
  "maxDepth",
  "averageDepth",
  "orphanPages",
  "brokenLinks",
] as const;

/** Keeps only finite numbers under well-formed names, clamped and bounded in count. */
export function sanitizeVector(input: Record<string, unknown>): FeatureVector {
  const out: FeatureVector = {};
  let count = 0;
  for (const name of Object.keys(input).sort()) {
    if (count >= MAX_FEATURES) break;
    const value = input[name];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (name.length > 96 || !NAME.test(name)) continue;
    out[name] = Math.max(-MAX_ABS, Math.min(MAX_ABS, value));
    count += 1;
  }
  return out;
}

/** The feature vector of a finished scan. Pure; no I/O. */
export function buildFeatureVector(outcome: AnalysisOutcome): FeatureVector {
  const raw: Record<string, unknown> = {
    "core.score": outcome.score,
    "core.passed": outcome.passedCount,
    "core.warnings": outcome.warningCount,
    "core.critical": outcome.criticalCount,
    "core.pages": outcome.pagesFetched,
    "core.partial": outcome.metrics.partial ? 1 : 0,
  };
  for (const category of outcome.categories) raw[`cat.${slug(category.id)}`] = category.score;
  for (const finding of outcome.findings) {
    if (finding.analyzer) continue; // analyzer lines come from the runner's own vector below
    const value = STATUS_VALUE[finding.status];
    if (value !== undefined) raw[`check.${slug(finding.id)}`] = value;
  }
  for (const key of METRICS) {
    const value = outcome.metrics[key];
    if (typeof value === "number") raw[`metric.${slug(key)}`] = value;
  }
  if (typeof outcome.metrics.aiReliable === "boolean") raw["metric.aireliable"] = outcome.metrics.aiReliable ? 1 : 0;
  for (const [name, value] of Object.entries(outcome.featureVector ?? {})) raw[`az.${slug(name)}`] = value;
  return sanitizeVector(raw);
}

/** Parses a stored vector, tolerating damage (a bad row is an empty vector, not a crash). */
export function parseVector(json: string | null | undefined): FeatureVector {
  if (!json) return {};
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? sanitizeVector(value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
