import type { Estimate } from "@/lib/ml/predict";
import type { FeatureVector } from "@/lib/ml/features";

import type { AnalyzerResult } from "../analyzers/contract";
import type { AnalysisOutcome } from "../types";

/**
 * Smart insights (features 48–53) — the analyzers that read a finished
 * scan rather than the website.
 *
 * They run after the scan has been scored, so they can see its score,
 * every finding and its feature vector, plus this account's own history
 * (earlier scans, schedules) and the prediction model. They never fetch
 * anything from the site. Like every analyzer they are gated by plan
 * feature, wrapped, time-limited and validated, and their lines carry
 * weight 0: an insight explains a score, it never changes one. They also
 * never report "fail" — an estimate or a comparison is advice, not a
 * failed check (the runner turns a stray "fail" into "warn").
 */

export type InsightContext = {
  userId: string;
  domain: string;
  reportId: string;
  websiteId: string;
  planId: string;
  /** The scored scan. Insight lines are not part of it. */
  outcome: AnalysisOutcome;
  vector: FeatureVector;
  /** The approval estimate for this scan (rule-based or trained model). */
  estimate: Estimate;
  /** The plan features this scan was entitled to. */
  features: ReadonlySet<string>;
  /** True for a sample report built without reaching the site. */
  demo: boolean;
  now: number;
};

export type InsightDef = {
  key: string;
  name: string;
  category: "smart";
  scope: "site";
  defaultPlan: "pro";
  timeoutMs?: number;
  run: (ctx: InsightContext) => Promise<AnalyzerResult> | AnalyzerResult;
};
