import { many, one } from "@/lib/db";
import { toReport, type Report, type ReportRow } from "@/lib/db/types";
import { FEATURE_META, type FeatureKey } from "@/lib/plans";

import { INSIGHT_KEYS } from "./keys";

/**
 * Comparing two scans of the same site — used by the "Changes since last
 * scan" line and by the weekly-rescan alert email, so both say the same
 * thing. Lines are matched by check id; smart-insight lines and lines that
 * could not run are not compared (they describe the scan, not the site).
 */

export type Line = { id: string; label: string; status: "pass" | "warn" | "fail" | "error"; priority: "high" | "medium" | "low" };

export type ScanDiff = {
  previous: { id: string; ref: string; score: number; at: number };
  scoreDelta: number;
  resolved: Line[];
  appeared: Line[];
  worsened: Line[];
  improved: Line[];
  persistent: Line[];
  featuresAdded: string[];
  featuresRemoved: string[];
  /** Lines present in only one scan because of the plan, not the site. */
  notCompared: number;
  meaningful: boolean;
};

const RANK = { pass: 2, warn: 1, fail: 0 } as const;

/** The latest complete, live scan of this site by this account before `excludeId`. */
export function previousLiveReport(userId: string, websiteId: string, excludeId: string, before = Date.now()): Report | null {
  const row = one<ReportRow>(
    `SELECT * FROM reports
      WHERE user_id = ? AND website_id = ? AND id <> ? AND state = 'complete' AND analysis_mode = 'live' AND created_at <= ?
      ORDER BY created_at DESC LIMIT 1`,
    [userId, websiteId, excludeId, before],
  );
  return row ? toReport(row) : null;
}

export function linesOfReport(reportId: string): Line[] {
  return many<{ check_id: string; label: string; status: Line["status"]; priority: Line["priority"] }>(
    "SELECT check_id, label, status, priority FROM report_issues WHERE report_id = ? ORDER BY sort_order",
    [reportId],
  ).map((r) => ({ id: r.check_id, label: r.label, status: r.status, priority: r.priority }));
}

export function featureLabel(key: string): string {
  return FEATURE_META[key as FeatureKey]?.label ?? key;
}

export function diffScans(input: {
  previous: { id: string; ref: string; score: number; at: number; features: readonly string[]; lines: Line[] };
  current: { score: number; features: readonly string[]; lines: Line[] };
}): ScanDiff {
  const usable = (lines: Line[]) => new Map(lines.filter((l) => !INSIGHT_KEYS.has(l.id) && l.status !== "error").map((l) => [l.id, l]));
  const before = usable(input.previous.lines);
  const after = usable(input.current.lines);
  const resolved: Line[] = [];
  const appeared: Line[] = [];
  const worsened: Line[] = [];
  const improved: Line[] = [];
  const persistent: Line[] = [];
  let notCompared = 0;

  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) {
      notCompared += 1; // not run last time (new check or plan change)
      continue;
    }
    if (now.status === "error" || was.status === "error") continue;
    const a = RANK[was.status as keyof typeof RANK];
    const b = RANK[now.status as keyof typeof RANK];
    if (a < 2 && b === 2) resolved.push(now);
    else if (a === 2 && b < 2) appeared.push(now);
    else if (b < a) worsened.push(now);
    else if (b > a) improved.push(now);
    else if (b < 2) persistent.push(now);
  }
  for (const id of before.keys()) if (!after.has(id)) notCompared += 1;

  const prevFeatures = new Set(input.previous.features);
  const currFeatures = new Set(input.current.features);
  const featuresAdded = [...currFeatures].filter((f) => !prevFeatures.has(f));
  const featuresRemoved = [...prevFeatures].filter((f) => !currFeatures.has(f));
  const scoreDelta = Math.round(input.current.score) - Math.round(input.previous.score);

  return {
    previous: { id: input.previous.id, ref: input.previous.ref, score: input.previous.score, at: input.previous.at },
    scoreDelta,
    resolved,
    appeared,
    worsened,
    improved,
    persistent,
    featuresAdded,
    featuresRemoved,
    notCompared,
    meaningful: resolved.length + appeared.length + worsened.length > 0 || Math.abs(scoreDelta) >= 5,
  };
}
