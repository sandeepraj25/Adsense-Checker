import { MODEL_LIMITATIONS } from "./constants";
import { describeFeature } from "./describe";
import type { FeatureVector } from "./features";
import { predictLogistic, predictSoftmax } from "./model";
import { ruleBasedEstimate, type RuleEstimate } from "./rules";
import { activeModelId, findModelVersion, toModelVersion, type ModelVersion } from "./store";

/**
 * The estimate for one scan: the active trained model when there is one,
 * otherwise the published rule-based index. Which one was used is always
 * part of the answer — a caller cannot show a model number without also
 * having its version, its validation figures and its limitations.
 */

export type ModelEstimate = {
  kind: "model";
  label: "Estimated (trained model)";
  /** Estimated probability of approval, 0–1, from the logistic model. */
  probability: number;
  version: string;
  algorithm: string;
  trainedAt: number;
  validation: { n: number; auc: number; logLoss: number; ece: number };
  /** Biggest pushes up and down for this scan, in plain English. */
  factors: Array<{ feature: string; label: string; value: number | null; effect: number }>;
  /** Likeliest rejection reasons, when a reason model passed validation. */
  reasons: Array<{ reason: string; probability: number }> | null;
  limitations: string;
};

export type Estimate = ModelEstimate | RuleEstimate;

let cached: ModelVersion | null = null;

/** The active model, parsed once per version. Null when none is active or it cannot be read. */
export function activeModel(): ModelVersion | null {
  const id = activeModelId();
  if (!id) {
    cached = null;
    return null;
  }
  if (cached?.id === id) return cached;
  const row = findModelVersion(id);
  if (!row) return null;
  try {
    cached = toModelVersion(row);
    return cached;
  } catch (error) {
    console.error(`[ml] active model ${row.version} could not be read: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

export function estimateApproval(vector: FeatureVector): Estimate {
  const model = activeModel();
  if (!model) return ruleBasedEstimate(vector);
  try {
    const { probability, contributions } = predictLogistic(model.model, vector);
    const reasons = model.reasonModel ? predictSoftmax(model.reasonModel, vector).slice(0, 3).map((r) => ({ reason: r.label, probability: r.probability })) : null;
    const up = contributions.filter((c) => c.contribution > 0).slice(0, 4);
    const down = contributions.filter((c) => c.contribution < 0).slice(0, 4);
    const v = model.metrics.validation;
    return {
      kind: "model",
      label: "Estimated (trained model)",
      probability,
      version: model.version,
      algorithm: model.algorithm,
      trainedAt: model.trainedAt,
      validation: { n: v.n, auc: v.auc, logLoss: v.logLoss, ece: v.ece },
      factors: [...up, ...down].map((c) => ({ feature: c.feature, label: describeFeature(c.feature), value: c.value, effect: Math.round(c.contribution * 1000) / 1000 })),
      reasons,
      limitations: MODEL_LIMITATIONS,
    };
  } catch (error) {
    // A broken model must not break a scan: fall back, and say why in the log.
    console.error(`[ml] prediction with ${model.version} failed, using the rule-based estimate: ${error instanceof Error ? error.message : error}`);
    return ruleBasedEstimate(vector);
  }
}

/** Test helper: forget the parsed model. */
export function resetModelCache(): void {
  cached = null;
}
