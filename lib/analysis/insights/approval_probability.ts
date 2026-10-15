import { MIN_LABELED_EXAMPLES } from "@/lib/ml/constants";

import type { AnalyzerFinding } from "../analyzers/contract";
import type { InsightDef } from "./contract";

/**
 * Feature 48 — the approval estimate.
 *
 * Shows whichever estimate this scan got (lib/ml/predict.ts): the
 * published rule-based index while fewer than 200 real outcomes exist,
 * then the trained model's probability. Either way the line names the
 * method, the model version and validation figures when there is a model,
 * the factors that moved the number, and its limitations.
 */
export const insight: InsightDef = {
  key: "approval_probability",
  name: "Approval estimate",
  category: "smart",
  scope: "site",
  defaultPlan: "pro",
  run({ estimate, demo }) {
    const findings: AnalyzerFinding[] = [];
    if (estimate.kind === "rule") {
      findings.push({
        message: `Method: Estimated (rule-based). A trained model is used only after ${MIN_LABELED_EXAMPLES} real outcomes have been reported.`,
        evidence: "index = 0.8 × readiness score + 20 × (1 − min(high-priority failures, 5) ÷ 5)",
      });
      for (const f of estimate.factors) findings.push({ message: `${f.label}: ${f.value ?? "—"} → ${f.points} points` });
      for (const w of estimate.weakest) findings.push({ message: `Weak area: ${w.label} ${Math.round(w.value)}/100` });
      findings.push({ message: estimate.limitations });
      if (demo) findings.push({ message: "This is a sample report, so the estimate describes sample data." });
      return {
        status: estimate.index >= 75 ? "pass" : "warn",
        score: estimate.index,
        summary: `Estimated (rule-based): readiness index ${estimate.index}/100 (${estimate.band}). This is not a probability of approval.`,
        findings,
        recommendation:
          estimate.index >= 75
            ? ""
            : `Raise the index by fixing high-priority failures first, then your weakest areas${estimate.weakest[0] ? ` (${estimate.weakest[0].label.toLowerCase()})` : ""}.`,
        confidence: "low",
      };
    }

    const pct = Math.round(estimate.probability * 100);
    const v = estimate.validation;
    findings.push({
      message: `Method: logistic regression trained on reported AdSense outcomes, model ${estimate.version}.`,
      evidence: `Validated on ${v.n} scans of sites it never saw: AUC ${v.auc.toFixed(2)}, log loss ${v.logLoss.toFixed(3)}, calibration error ${v.ece.toFixed(3)}.`,
    });
    for (const f of estimate.factors) {
      findings.push({ message: `${f.effect > 0 ? "Raises" : "Lowers"} the estimate: ${f.label}${f.value !== null ? ` (${Math.round(f.value * 100) / 100})` : " (not measured on this plan)"}` });
    }
    findings.push({ message: estimate.limitations });
    const lowering = estimate.factors.filter((f) => f.effect < 0).slice(0, 2).map((f) => f.label.toLowerCase());
    return {
      status: pct >= 70 ? "pass" : "warn",
      score: pct,
      summary: `Estimated approval probability ${pct}% (trained model ${estimate.version}). An estimate from past outcomes, not a guarantee.`,
      findings,
      recommendation: pct >= 70 ? "" : lowering.length ? `The biggest drags on this estimate: ${lowering.join(" and ")}.` : "Work through the failed checks in this report, highest priority first.",
      confidence: v.n >= 100 ? "medium" : "low",
    };
  },
};
