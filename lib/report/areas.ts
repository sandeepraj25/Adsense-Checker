import { ANALYZER_CATALOG, ANALYZER_CATEGORY_LABEL, type AnalyzerCategory } from "@/lib/analysis/analyzers/catalog";
import type { ReportIssue } from "@/lib/db/types";
import type { FeatureKey } from "@/lib/plans";

/**
 * The five report areas (Phase 6): Content, Policy, Trust, Technical and
 * Smart insights.
 *
 * They sit beside the six score categories rather than replacing them —
 * the score, its weights and every stored report stay as they were. An
 * area is worked out when a report is shown, so reports from before this
 * version are grouped too:
 *
 *   1. an analyzer line carries its own area (details_json.category);
 *   2. otherwise its feature, when that feature is in the analyzer
 *      registry (an older row without details);
 *   3. otherwise a built-in check, by check id where the score category
 *      would mislead (contact and about pages are about trust), then by
 *      feature (policy checks), then by score category.
 */
export type ReportArea = AnalyzerCategory;

export const REPORT_AREAS: readonly ReportArea[] = ["content", "policy", "trust", "technical", "smart"];

export const AREA_LABEL: Record<ReportArea, string> = ANALYZER_CATEGORY_LABEL;

export const AREA_BLURB: Record<ReportArea, string> = {
  content: "What you publish: depth, originality and how it reads.",
  policy: "AdSense programme policies, disclosures and ad placement.",
  trust: "Who is behind the site and whether a reviewer can reach them.",
  technical: "HTTPS, crawling, speed and how pages are built.",
  smart: "Estimates and comparisons drawn from this scan. They never change the score.",
};

const FEATURE_AREA = new Map<string, ReportArea>([
  ...ANALYZER_CATALOG.map((entry) => [entry.key, entry.category] as [string, ReportArea]),
  ["adsense_policy_check", "policy"],
  ["policy_risk_detection", "policy"],
  ["ad_density_analysis", "policy"],
]);

const CHECK_AREA: Record<string, ReportArea> = {
  "pvl-contact": "trust",
  "pvl-about": "trust",
  "tec-ads-txt": "policy",
};

const SCORE_CATEGORY_AREA: Record<string, ReportArea> = {
  content: "content",
  privacy: "policy",
  navigation: "trust",
  seo: "technical",
  mobile: "technical",
  technical: "technical",
};

export function areaOf(issue: Pick<ReportIssue, "checkId" | "categoryId" | "feature" | "analyzer">): ReportArea {
  if (issue.analyzer) return issue.analyzer.category;
  const byCheck = CHECK_AREA[issue.checkId];
  if (byCheck) return byCheck;
  const byFeature = issue.feature ? FEATURE_AREA.get(issue.feature) : undefined;
  if (byFeature) return byFeature;
  return SCORE_CATEGORY_AREA[issue.categoryId] ?? "technical";
}

/** The area a feature's findings land in (for the locked-features list). */
export function areaOfFeature(feature: FeatureKey): ReportArea | null {
  return FEATURE_AREA.get(feature) ?? null;
}

export type AreaCount = { area: ReportArea; open: number; passed: number; total: number };

/** Open (fail + warn) and passed lines per area; errors are left out. */
export function countByArea(issues: readonly ReportIssue[]): AreaCount[] {
  return REPORT_AREAS.map((area) => {
    const mine = issues.filter((issue) => areaOf(issue) === area && issue.status !== "error");
    const open = mine.filter((issue) => issue.status === "fail" || issue.status === "warn").length;
    const passed = mine.filter((issue) => issue.status === "pass").length;
    return { area, open, passed, total: open + passed };
  });
}

/** Splits the smart-insight lines from the findings they explain. */
export function splitInsights(issues: readonly ReportIssue[]): { findings: ReportIssue[]; insights: ReportIssue[] } {
  const findings: ReportIssue[] = [];
  const insights: ReportIssue[] = [];
  for (const issue of issues) (areaOf(issue) === "smart" ? insights : findings).push(issue);
  return { findings, insights };
}

/**
 * Plain status words, the same everywhere (web and PDF). Never "rejected":
 * the product can say what a reviewer is likely to object to, not what
 * Google will decide.
 */
export const STATUS_LABEL: Record<ReportIssue["status"], string> = {
  fail: "Blocker",
  warn: "Worth fixing",
  pass: "Passed",
  error: "Couldn't run",
};

export const CONFIDENCE_LABEL: Record<"high" | "medium" | "low", string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence — treat as a hint",
};
