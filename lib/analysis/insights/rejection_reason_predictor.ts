import { rejectionReasonLabel, type RejectionReason } from "@/lib/ml/constants";
import { activeModel } from "@/lib/ml/predict";
import { predictSoftmax } from "@/lib/ml/model";

import type { Finding } from "../types";
import type { InsightDef } from "./contract";

/**
 * Feature 49 — which AdSense rejection reasons this scan points to.
 *
 * With a trained reason model (softmax regression over reported reasons,
 * promoted only when it beat the base rates on held-out sites) the line
 * gives its probabilities. Until then it uses a published mapping from
 * this scan's own failed and warned lines to Google's reason categories,
 * weighted by priority, and says so. Either way: an estimate of which
 * category fits the evidence — not knowledge of Google's decision.
 */

/** Which reason category each kind of problem evidences. */
const REASON_OF: Array<{ reason: RejectionReason; ids: RegExp }> = [
  { reason: "policy_violation", ids: /^(hidden_text|malicious_js|cloaking_detection|popup_interstitial|conflicting_ad_networks|ad_click_encouragement|fake_download_buttons|auto_redirect|ymyl_without_disclaimer|comment_spam|affiliate_density|duplicate_adsense_tag|pub_id_crosscheck|generic_privacy_policy|privacy_ads_disclosure|cnt-restricted|tec-ad-density|pvl-privacy|pvl-cookie-notice)$/ },
  { reason: "under_construction", ids: /^(placeholder_text|default_theme_leftovers|parked_domain|stale_copyright_year|cnt-placeholder)$/ },
  { reason: "insufficient_content", ids: /^(real_word_count|thin_post_distribution|content_freshness|publishing_velocity|cnt-thin|cnt-depth|cnt-breadth)$/ },
  { reason: "copied_content", ids: /^(cnt-originality|cnt-duplicate-pages|cnt-ai-estimate|cnt-human-signals)$/ },
  { reason: "low_value_content", ids: /^(boilerplate_ratio|keyword_stuffing|clickbait_score|readability_score|niche_focus|hotlinked_images|language_check|mixed_language_ratio|author_bylines|cnt-.*)$/ },
  { reason: "navigation", ids: /^(essential_pages|soft_404|custom_404|canonical_hijack|url_hygiene|pvl-contact|pvl-about|pvl-terms|nav-.*|mob-.*)$/ },
  { reason: "site_unavailable", ids: /^(tec-status|tec-robots|tec-crawlability|tec-speed|page_weight)$/ },
];

const POINTS = { fail: { high: 5, medium: 3, low: 2 }, warn: { high: 2, medium: 1, low: 0.5 } } as const;

export function ruleBasedReasons(findings: Finding[]): Array<{ reason: RejectionReason; share: number; lines: string[] }> {
  const totals = new Map<RejectionReason, { points: number; lines: string[] }>();
  for (const f of findings) {
    if (f.status !== "fail" && f.status !== "warn") continue;
    if (f.analyzer?.category === "smart") continue;
    const match = REASON_OF.find((r) => r.ids.test(f.id));
    if (!match) continue;
    const entry = totals.get(match.reason) ?? { points: 0, lines: [] };
    entry.points += POINTS[f.status][f.priority];
    entry.lines.push(f.label);
    totals.set(match.reason, entry);
  }
  const sum = [...totals.values()].reduce((s, e) => s + e.points, 0);
  return [...totals.entries()]
    .map(([reason, e]) => ({ reason, share: sum ? e.points / sum : 0, lines: e.lines }))
    .sort((a, b) => b.share - a.share);
}

export const insight: InsightDef = {
  key: "rejection_reason_predictor",
  name: "Likely rejection reasons",
  category: "smart",
  scope: "site",
  defaultPlan: "pro",
  run({ outcome, vector }) {
    const model = activeModel();
    if (model?.reasonModel) {
      const ranked = predictSoftmax(model.reasonModel, vector).slice(0, 3);
      const metrics = model.metrics.reasons;
      return {
        status: "warn",
        summary: `If this site were rejected, the likeliest stated reason would be ${rejectionReasonLabel(ranked[0]!.label).toLowerCase()} (${Math.round(ranked[0]!.probability * 100)}%, trained model ${model.version}).`,
        findings: [
          ...ranked.map((r) => ({ message: `${rejectionReasonLabel(r.label)}: ${Math.round(r.probability * 100)}%` })),
          {
            message: `Method: softmax regression over rejection reasons owners reported, model ${model.version}.`,
            evidence: metrics ? `Held-out accuracy ${Math.round(metrics.accuracy * 100)}% across ${metrics.classes.length} reasons on ${metrics.n} scans.` : undefined,
          },
          { message: "These are probabilities over reported reasons, given a rejection. They are not Google's decision and say nothing about whether you will be rejected." },
        ],
        recommendation: "Start with the checks in this report that relate to the top reason.",
        confidence: "low",
      };
    }

    const ranked = ruleBasedReasons(outcome.findings).slice(0, 3);
    if (ranked.length === 0) {
      return {
        status: "pass",
        summary: "Estimated (rule-based): nothing in this scan points to a common rejection reason.",
        findings: [{ message: "No failed or warned check maps to a rejection category. Google can still reject for reasons a scan cannot see, such as invalid traffic or account history." }],
        recommendation: "",
        confidence: "low",
      };
    }
    return {
      status: "warn",
      summary: `Estimated (rule-based): the evidence points most to “${rejectionReasonLabel(ranked[0]!.reason)}”.`,
      findings: [
        ...ranked.map((r) => ({
          message: `${rejectionReasonLabel(r.reason)} — ${Math.round(r.share * 100)}% of the weighted evidence`,
          evidence: r.lines.slice(0, 4).join(", "),
        })),
        { message: "Method: each failed or warned line is mapped to the rejection category it evidences and weighted by priority. Shares compare categories with each other; they are not probabilities and not Google's decision." },
      ],
      recommendation: `Fix the lines behind “${rejectionReasonLabel(ranked[0]!.reason)}” first: ${ranked[0]!.lines.slice(0, 3).join(", ")}.`,
      confidence: "low",
    };
  },
};
