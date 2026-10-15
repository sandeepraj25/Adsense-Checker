import { RULE_LIMITATIONS } from "./constants";
import { describeFeature } from "./describe";
import type { FeatureVector } from "./features";

/**
 * The cold-start estimate, used until enough real outcomes exist to train
 * a model. Deliberately simple and fully published, so nobody can mistake
 * it for something learned:
 *
 *   index = 0.8 × readiness score
 *         + 20 × (1 − min(high-priority failures, 5) / 5)
 *
 * clamped to 0–100. The readiness score is the report's own weighted
 * category score; the second term rewards having no high-priority
 * failures at all, because a single serious problem matters more than its
 * share of the average suggests. It is an index, not a probability.
 */

export type RuleEstimate = {
  kind: "rule";
  label: "Estimated (rule-based)";
  index: number;
  band: "low" | "moderate" | "high";
  factors: Array<{ feature: string; label: string; value: number | null; points: number }>;
  weakest: Array<{ feature: string; label: string; value: number }>;
  limitations: string;
};

export function ruleBasedEstimate(vector: FeatureVector): RuleEstimate {
  const score = Math.max(0, Math.min(100, vector["core.score"] ?? 0));
  const critical = Math.max(0, vector["core.critical"] ?? 0);
  const scorePoints = 0.8 * score;
  const criticalPoints = 20 * (1 - Math.min(critical, 5) / 5);
  const index = Math.round(Math.max(0, Math.min(100, scorePoints + criticalPoints)));
  const weakest = Object.entries(vector)
    .filter(([name]) => name.startsWith("cat."))
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([feature, value]) => ({ feature, label: describeFeature(feature), value }));
  return {
    kind: "rule",
    label: "Estimated (rule-based)",
    index,
    band: index >= 75 ? "high" : index >= 50 ? "moderate" : "low",
    factors: [
      { feature: "core.score", label: describeFeature("core.score"), value: vector["core.score"] ?? null, points: Math.round(scorePoints * 10) / 10 },
      { feature: "core.critical", label: describeFeature("core.critical"), value: vector["core.critical"] ?? null, points: Math.round(criticalPoints * 10) / 10 },
    ],
    weakest,
    limitations: RULE_LIMITATIONS,
  };
}
