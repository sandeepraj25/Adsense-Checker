import type { AnalysisOutcome } from "@/lib/analysis/types";

import { ensureFeedbackRequest } from "./feedback";
import { buildFeatureVector, FEATURE_SCHEMA, type FeatureVector } from "./features";
import { estimateApproval, type Estimate } from "./predict";
import { insertScanFeatures } from "./store";

/**
 * The end of every completed live scan: store its feature vector and the
 * estimate it got, and open (or move) the 14-day feedback prompt.
 *
 * Demo reports are never stored — they are sample data, not a site.
 * Storage is keyed on the report id, so calling this twice for the same
 * scan stores one row. A failure here is logged and never fails the scan
 * the person has already paid for.
 */
export function collectScanFeatures(input: {
  reportId: string;
  userId: string;
  domain: string;
  planId: string;
  demo: boolean;
  outcome: AnalysisOutcome;
  /** Already computed for this scan (the insights use the same ones). */
  vector?: FeatureVector;
  estimate?: Estimate;
  now?: number;
}): { stored: boolean; estimate: Estimate | null } {
  if (input.demo) return { stored: false, estimate: null };
  const now = input.now ?? Date.now();
  try {
    const vector = input.vector ?? buildFeatureVector(input.outcome);
    const estimate = input.estimate ?? estimateApproval(vector);
    const stored = insertScanFeatures({
      reportId: input.reportId,
      userId: input.userId,
      domain: input.domain,
      planId: input.planId,
      analysisMode: "live",
      featureSchema: FEATURE_SCHEMA,
      vector,
      modelVersion: estimate.kind === "model" ? estimate.version : "rule-based",
      estimate,
      niche: input.outcome.metrics.niche ?? null,
      now,
    });
    if (stored) ensureFeedbackRequest({ userId: input.userId, domain: input.domain, reportId: input.reportId, scannedAt: now, now });
    return { stored, estimate };
  } catch (error) {
    console.error(`[ml] could not store features for report ${input.reportId}: ${error instanceof Error ? error.message : error}`);
    return { stored: false, estimate: null };
  }
}
