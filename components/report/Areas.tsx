import { Lightbulb, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import type { ReportIssue } from "@/lib/db/types";
import { AREA_BLURB, AREA_LABEL, CONFIDENCE_LABEL, type AreaCount } from "@/lib/report/areas";

/**
 * Findings by area (Content, Policy, Trust, Technical, Smart insights):
 * open items and passed checks in each. An area with nothing in it on
 * this plan says so instead of showing a zero that reads like a clean bill.
 */
export function AreaSummary({ counts }: { counts: AreaCount[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Findings by area">
      {counts.map(({ area, open, passed, total }) => (
        <li
          key={area}
          data-area={area}
          className="glass flex min-w-0 flex-col rounded-xl border border-ink-700 bg-white px-4 py-3.5"
        >
          <span className="text-[0.8125rem] font-medium text-cloud-500">{AREA_LABEL[area]}</span>
          {total === 0 ? (
            <span className="mt-1 text-[0.875rem] text-cloud-400">Not checked on this plan</span>
          ) : area === "smart" ? (
            <span className="mt-1 text-[0.875rem] text-cloud-200">
              <span className="t-data text-[1.25rem] font-semibold text-cloud-50">{total}</span> insight{total === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="mt-1 text-[0.875rem] text-cloud-200">
              <span className={cn("t-data text-[1.25rem] font-semibold", open > 0 ? "text-amber-400" : "text-mint-400")}>{open}</span>{" "}
              to act on
              <span className="block text-[0.75rem] text-cloud-400">{passed} passed</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The smart insights (features 48–53) as their own section: estimates and
 * comparisons that explain the result. Kept apart from the findings so an
 * estimate is never read as a failed check.
 */
/** Insights that estimate (the others report facts: changes, schedules). */
const ESTIMATES = new Set(["approval_probability", "rejection_reason_predictor", "similar_sites_comparison", "readiness_timeline"]);

export function SmartInsights({ insights }: { insights: ReportIssue[] }) {
  if (insights.length === 0) return null;
  return (
    <section data-section="smart-insights">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <Sparkles className="size-5 text-azure-600" aria-hidden />
          <h2 className="text-[1.2rem] font-semibold tracking-tight text-cloud-50">Smart insights</h2>
        </div>
        <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-cloud-300">{AREA_BLURB.smart} None of them is a Google decision.</p>
      </div>

      <div className="mt-5 grid gap-3.5 lg:grid-cols-2">
        {insights.map((insight) => {
          const items = insight.analyzer?.items ?? [];
          const confidence = insight.analyzer?.confidence;
          return (
            <article
              key={insight.id}
              data-area="smart"
              className="glass flex min-w-0 flex-col rounded-xl border border-ink-700 bg-white p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 break-words text-[1rem] font-semibold text-cloud-50">{insight.label}</h3>
                <span className="shrink-0 rounded-md border border-azure-400/20 bg-azure-400/[0.06] px-2 py-0.5 text-[0.75rem] font-medium text-azure-600">
                  {ESTIMATES.has(insight.checkId) ? "Estimate" : "Insight"}
                </span>
              </div>
              <p className="mt-2.5 break-words text-[0.9375rem] leading-relaxed text-cloud-200">{insight.detail}</p>
              {confidence && confidence !== "high" ? <p className="mt-1.5 text-[0.8125rem] text-cloud-400">{CONFIDENCE_LABEL[confidence]}</p> : null}
              {items.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {items.slice(0, 6).map((item, index) => (
                    <li key={index} className="break-words text-[0.875rem] leading-relaxed text-cloud-300">
                      {item.message}
                      {item.evidence ? (
                        <span className="mt-0.5 block break-anywhere font-mono text-[0.8125rem] text-cloud-400">{item.evidence}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {insight.recommendation ? (
                <p className="mt-3 flex gap-2 border-t border-ink-700 pt-3 text-[0.875rem] leading-relaxed text-cloud-200">
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-azure-600" aria-hidden />
                  <span className="min-w-0 break-words">{insight.recommendation}</span>
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
