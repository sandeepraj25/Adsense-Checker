import { many } from "@/lib/db";
import { parseVector } from "@/lib/ml/features";

import type { AnalyzerFinding } from "../analyzers/contract";
import type { InsightDef } from "./contract";
import { INSIGHT_KEYS } from "./keys";

/**
 * Feature 52 — roughly how long until this site looks ready, from what
 * is left to fix, how much content it has and how fast it publishes.
 *
 * A planning aid built on stated assumptions, shown with every estimate:
 *
 *   fix effort   working days per open problem: failed high 3, failed
 *                medium 1.5, failed low 0.5, warning high 1, warning
 *                medium 0.5, warning low 0.25 — done at about 3 working
 *                days per week
 *   content gap  25 indexable pages (a common rule of thumb for content
 *                sites, not a Google requirement), counted from the
 *                sitemap
 *   pace         sitemap growth between this and earlier scans when one
 *                is at least a week old; otherwise posts dated in the
 *                last 90 days; otherwise an assumed 2 posts a week
 *
 * Fixing and writing happen side by side, so the estimate is the longer
 * of the two, shown as a range (×0.6 to ×1.5). It never gives a date
 * Google will approve, and does not include Google's own review time.
 */

export const TARGET_PAGES = 25;
const EFFORT = { fail: { high: 3, medium: 1.5, low: 0.5 }, warn: { high: 1, medium: 0.5, low: 0.25 } } as const;
const DAYS_PER_WEEK = 3;
const ASSUMED_POSTS_PER_WEEK = 2;
const WEEK = 7 * 86_400_000;

function weeks(n: number): string {
  if (n < 1) return "under a week";
  const r = Math.round(n);
  return `${r} week${r === 1 ? "" : "s"}`;
}

export const insight: InsightDef = {
  key: "readiness_timeline",
  name: "Readiness timeline",
  category: "smart",
  scope: "site",
  defaultPlan: "pro",
  run({ outcome, vector, userId, domain, now }) {
    const open = outcome.findings.filter((f) => !INSIGHT_KEYS.has(f.id) && (f.status === "fail" || f.status === "warn"));
    const effortDays = open.reduce((sum, f) => sum + EFFORT[f.status as "fail" | "warn"][f.priority], 0);
    const fixWeeks = effortDays / DAYS_PER_WEEK;

    const pages = vector["metric.sitemapurls"];
    let pace: number | null = null;
    let paceSource = "";
    if (pages !== undefined) {
      const earlier = many<{ vector_json: string; created_at: number }>(
        "SELECT vector_json, created_at FROM scan_features WHERE user_id = ? AND domain = ? AND created_at <= ? ORDER BY created_at ASC LIMIT 50",
        [userId, domain, now - WEEK],
      );
      const first = earlier.map((r) => ({ at: r.created_at, urls: parseVector(r.vector_json)["metric.sitemapurls"] })).find((r) => r.urls !== undefined);
      if (first && pages >= first.urls!) {
        pace = (pages - first.urls!) / ((now - first.at) / WEEK);
        paceSource = `sitemap grew from ${first.urls} to ${pages} URLs since your scan on ${new Date(first.at).toISOString().slice(0, 10)}`;
      }
    }
    const recent = vector["az.publishing_velocity.dated_last_90_days"];
    if ((pace === null || pace === 0) && recent !== undefined && recent > 0) {
      pace = recent / (90 / 7);
      paceSource = `${recent} posts dated in the last 90 days`;
    }
    const assumedPace = pace === null || pace <= 0;
    if (assumedPace) {
      pace = ASSUMED_POSTS_PER_WEEK;
      paceSource = `no publishing pace could be measured, so ${ASSUMED_POSTS_PER_WEEK} posts a week is assumed`;
    }
    const gap = pages === undefined ? null : Math.max(0, TARGET_PAGES - pages);
    const contentWeeks = gap === null ? 0 : gap / pace!;
    const central = Math.max(fixWeeks, contentWeeks);
    const low = central * 0.6;
    const high = central * 1.5;

    const findings: AnalyzerFinding[] = [
      {
        message: `Fixes: ${open.length} open problem${open.length === 1 ? "" : "s"} ≈ ${Math.round(effortDays * 10) / 10} working days, about ${weeks(fixWeeks)} at ${DAYS_PER_WEEK} days a week.`,
        evidence: open.filter((f) => f.status === "fail").slice(0, 5).map((f) => f.label).join(", ") || undefined,
      },
      gap === null
        ? { message: "Content: the sitemap could not be read, so the content gap is not estimated." }
        : { message: `Content: ${pages} URLs in the sitemap vs a working target of ${TARGET_PAGES}; ${gap} to go at ${Math.round(pace! * 10) / 10} a week ≈ ${weeks(contentWeeks)}.`, evidence: `Pace: ${paceSource}.` },
      { message: `Assumptions: effort per problem by priority, ${TARGET_PAGES} pages as a rule of thumb (not a Google rule), fixing and writing in parallel, range ×0.6–×1.5. Google's own review time is not included, and no approval date is implied.` },
    ];
    const ready = open.every((f) => f.status !== "fail") && high < 1;
    return {
      status: ready ? "pass" : "warn",
      summary: ready
        ? "Little left to do by these measures — the site may be ready to apply. This is not a promise of approval."
        : `Rough estimate: ${weeks(low)} to ${weeks(high)} of work before this site looks ready, on the assumptions listed. Not an approval date.`,
      findings,
      recommendation: ready ? "" : contentWeeks > fixWeeks ? "Content volume is the longer path: keep publishing original, useful posts while you fix the open problems." : "Fixing the open problems is the longer path: start with the failed high-priority checks.",
      confidence: assumedPace || gap === null ? "low" : "medium",
    };
  },
};
