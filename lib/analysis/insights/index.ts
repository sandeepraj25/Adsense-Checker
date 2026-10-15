import { insight as approval_probability } from "./approval_probability";
import type { InsightDef } from "./contract";
import { INSIGHT_REGISTRY } from "./keys";
import { insight as readiness_timeline } from "./readiness_timeline";
import { insight as rejection_reason_predictor } from "./rejection_reason_predictor";
import { insight as rescan_diff } from "./rescan_diff";
import { insight as scheduled_rescan } from "./scheduled_rescan";
import { insight as similar_sites_comparison } from "./similar_sites_comparison";

/** Every smart insight, in report order. Must match ./keys.ts (checked by the tests). */
export const INSIGHTS: readonly InsightDef[] = [
  approval_probability,
  rejection_reason_predictor,
  similar_sites_comparison,
  rescan_diff,
  readiness_timeline,
  scheduled_rescan,
];

export function assertInsights(): string[] {
  const problems: string[] = [];
  const keys = INSIGHTS.map((i) => i.key);
  if (keys.join() !== INSIGHT_REGISTRY.map((e) => e.key).join()) problems.push("INSIGHTS and INSIGHT_REGISTRY differ");
  return problems;
}

export { runInsights } from "./runner";
export type { InsightContext, InsightDef } from "./contract";
