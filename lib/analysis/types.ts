import type { IssuePriority, IssueStatus, PageScore, ReportMetrics, Verdict } from "@/lib/db/types";
import type { FeatureKey } from "@/lib/plans";

export const ENGINE_VERSION = "2.0.0";

export const CATEGORY_KEYS = [
  "content",
  "seo",
  "navigation",
  "mobile",
  "privacy",
  "technical",
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/**
 * Weights sum to 100 and reflect how AdSense reviews actually fall over:
 * thin content and missing policy pages account for the great majority
 * of rejections, so they carry the most.
 */
export const CATEGORY_META: Record<
  CategoryKey,
  { name: string; code: string; weight: number; blurb: string }
> = {
  content: {
    name: "Content quality",
    code: "CNT",
    weight: 26,
    blurb: "Depth, originality and consistency of what you publish.",
  },
  privacy: {
    name: "Privacy & legal",
    code: "PVL",
    weight: 20,
    blurb: "The pages reviewers look for before anything else.",
  },
  seo: {
    name: "SEO",
    code: "SEO",
    weight: 16,
    blurb: "Titles, descriptions and crawl signals on your pages.",
  },
  navigation: {
    name: "Navigation",
    code: "NAV",
    weight: 14,
    blurb: "Whether a reviewer can find their way around.",
  },
  mobile: {
    name: "Mobile experience",
    code: "MOB",
    weight: 12,
    blurb: "How the site behaves on a phone-sized screen.",
  },
  technical: {
    name: "Technical health",
    code: "TEC",
    weight: 12,
    blurb: "HTTPS, crawler access and response speed.",
  },
};

/** A single verdict on a single check. */
export type Finding = {
  id: string;
  category: CategoryKey;
  label: string;
  status: IssueStatus;
  /** What was observed, in plain language. */
  detail: string;
  /** What to do about it. Empty for a pass. */
  fix: string;
  priority: IssuePriority;
  /** Relative importance within its category. */
  weight: number;
  /** Optional raw evidence — a URL, a count, a snippet. */
  evidence?: string;
  /**
   * The advertised feature that produced this finding.
   *
   * Undefined means the check is part of the base page read that every
   * plan gets. Anything else is gated: the check does not run at all
   * unless the account holds that feature, which is what keeps the
   * pricing page honest.
   */
  feature?: FeatureKey;
};

/** One item of the Pro remediation plan, in the order to work through. */
export type { Recommendation, PolicyRisk } from "@/lib/db/types";

export type ScoredCategory = {
  id: CategoryKey;
  name: string;
  code: string;
  score: number;
  weight: number;
  passed: number;
  warnings: number;
  critical: number;
};

export type AnalysisOutcome = {
  score: number;
  verdict: Verdict;
  categories: ScoredCategory[];
  findings: Finding[];
  passedCount: number;
  warningCount: number;
  criticalCount: number;
  pagesFetched: number;
  /** Pages the crawler actually read, for the report's evidence trail. */
  pageUrls: string[];
  /** Features that were active for this run. */
  features: FeatureKey[];
  /** Features a higher plan would have added. Drives the upgrade prompts. */
  locked: FeatureKey[];
  /** Per-page scores. Empty unless page_by_page_analysis was active. */
  pages: PageScore[];
  /** Headline numbers worth keeping beside the score. */
  metrics: ReportMetrics;
  /** How many checks actually ran, which varies by plan. */
  checksRun: number;
};

export class AnalysisFailure extends Error {
  constructor(
    message: string,
    /** True when the site itself is unreachable rather than merely poor. */
    readonly unreachable = false,
  ) {
    super(message);
    this.name = "AnalysisFailure";
  }
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  ready: "Ready",
  needs_improvement: "Needs improvement",
  not_ready: "Not ready",
};
