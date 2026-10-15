import { many } from "@/lib/db";
import { FEATURE_SCHEMA, parseVector } from "@/lib/ml/features";

import { nicheLabel } from "../niche";
import type { AnalyzerFinding } from "../analyzers/contract";
import type { InsightDef } from "./contract";

/**
 * Feature 50 — this site against other scanned sites in the same niche.
 *
 * Only aggregates are shown, and only when the group is big enough to
 * stay anonymous: at least 10 different sites from at least 3 different
 * accounts (each site counted once, by its latest scan). No other site's
 * domain or numbers are ever shown. "Reported approved" uses only sites
 * whose owners reported an approval (accepted labels) and appears only
 * with 10 such sites — it is the owners' report, not a verified fact.
 */

export const MIN_COHORT_SITES = 10;
export const MIN_COHORT_ACCOUNTS = 3;

const METRICS: Array<{ name: string; label: string; better: "higher" | "lower"; digits?: number }> = [
  { name: "core.score", label: "Readiness score", better: "higher" },
  { name: "core.critical", label: "High-priority failures", better: "lower" },
  { name: "metric.averagewords", label: "Average words per page", better: "higher" },
  { name: "metric.sitemapurls", label: "URLs in sitemap", better: "higher" },
  { name: "cat.privacy", label: "Privacy & legal score", better: "higher" },
  { name: "cat.content", label: "Content quality score", better: "higher" },
];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function fmt(n: number): string {
  return Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

export const insight: InsightDef = {
  key: "similar_sites_comparison",
  name: "Similar sites comparison",
  category: "smart",
  scope: "site",
  defaultPlan: "pro",
  run({ outcome, vector, domain }) {
    const niche = outcome.metrics.niche ?? "general";
    const label = nicheLabel(niche);
    if (niche === "general") {
      return {
        status: "pass",
        summary: "This site's niche couldn't be identified with confidence, so it isn't compared with other sites.",
        findings: [{ message: "Comparisons are only made within one clear niche, so unlike sites are never set side by side." }],
        recommendation: "",
        confidence: "low",
      };
    }
    const rows = many<{ domain: string; user_id: string; vector_json: string; label: string | null; label_status: string }>(
      `SELECT s.domain, s.user_id, s.vector_json, s.label, s.label_status FROM scan_features s
        WHERE s.niche = ? AND s.feature_schema = ? AND s.analysis_mode = 'live' AND s.domain <> ?
          AND s.created_at = (SELECT MAX(t.created_at) FROM scan_features t WHERE t.domain = s.domain AND t.niche = s.niche)
        ORDER BY s.created_at DESC LIMIT 2000`,
      [niche, FEATURE_SCHEMA, domain],
    );
    const sites = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!sites.has(row.domain)) sites.set(row.domain, row);
    const cohort = [...sites.values()];
    const accounts = new Set(cohort.map((r) => r.user_id)).size;
    if (cohort.length < MIN_COHORT_SITES || accounts < MIN_COHORT_ACCOUNTS) {
      return {
        status: "warn",
        summary: `Not enough comparable ${label.toLowerCase()} sites yet (${cohort.length} of ${MIN_COHORT_SITES} needed from at least ${MIN_COHORT_ACCOUNTS} accounts).`,
        findings: [{ message: "Comparisons appear once enough different sites in this niche have been scanned, so that no single site can be singled out." }],
        recommendation: "",
        confidence: "low",
      };
    }

    const vectors = cohort.map((r) => parseVector(r.vector_json));
    const approved = cohort.map((r, i) => ({ r, v: vectors[i]! })).filter(({ r }) => r.label === "approved" && r.label_status === "accepted");
    const findings: AnalyzerFinding[] = [];
    let behind = 0;
    let compared = 0;
    for (const metric of METRICS) {
      const mine = vector[metric.name];
      const values = vectors.map((v) => v[metric.name]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
      if (mine === undefined || values.length < MIN_COHORT_SITES) continue;
      compared += 1;
      const median = quantile(values, 0.5);
      const below = values.filter((x) => x < mine).length + values.filter((x) => x === mine).length / 2;
      const percentile = Math.round((below / values.length) * 100);
      const standing = metric.better === "higher" ? percentile : 100 - percentile;
      if (standing < 40) behind += 1;
      const approvedValues = approved.map(({ v }) => v[metric.name]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
      findings.push({
        message: `${metric.label}: yours ${fmt(mine)}, niche median ${fmt(median)} (middle half ${fmt(quantile(values, 0.25))}–${fmt(quantile(values, 0.75))}).`,
        evidence: `Better than about ${standing}% of ${values.length} sites${approvedValues.length >= MIN_COHORT_SITES ? `; median of ${approvedValues.length} sites whose owners reported approval: ${fmt(quantile(approvedValues, 0.5))}` : ""}.`,
      });
    }
    findings.push({ message: `Group: the latest scan of ${cohort.length} other ${label.toLowerCase()} sites from ${accounts} accounts. Only aggregates are shown.` });
    if (approved.length > 0 && approved.length < MIN_COHORT_SITES) {
      findings.push({ message: `${approved.length} of these sites have a reported approval — too few to show their figures separately.` });
    }
    return {
      status: behind >= 2 ? "warn" : "pass",
      summary: `Compared with ${cohort.length} ${label.toLowerCase()} sites: behind the typical site on ${behind} of ${compared} measures.`,
      findings,
      recommendation: behind >= 2 ? "Focus on the measures where you are behind most sites in your niche." : "",
      confidence: cohort.length >= 50 ? "medium" : "low",
    };
  },
};
