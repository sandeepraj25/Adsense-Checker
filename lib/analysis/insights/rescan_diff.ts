import { formatDate } from "@/lib/format";

import type { AnalyzerFinding } from "../analyzers/contract";
import type { InsightDef } from "./contract";
import { diffScans, featureLabel, linesOfReport, previousLiveReport } from "./history";

/**
 * Feature 51 — what changed since this account's previous scan of the
 * same site: problems fixed, new problems, problems that got worse or
 * remain, the score change, and checks added or removed by a plan change.
 */
export const insight: InsightDef = {
  key: "rescan_diff",
  name: "Changes since last scan",
  category: "smart",
  scope: "site",
  defaultPlan: "pro",
  run({ userId, websiteId, reportId, outcome, now, demo }) {
    if (demo) {
      return { status: "pass", summary: "Sample report: there is no earlier scan to compare with.", findings: [], recommendation: "", confidence: "low" };
    }
    const previous = previousLiveReport(userId, websiteId, reportId, now);
    if (!previous) {
      return {
        status: "pass",
        summary: "First complete scan of this site — your next scan will show what changed.",
        findings: [],
        recommendation: "",
        confidence: "high",
      };
    }
    const diff = diffScans({
      previous: { id: previous.id, ref: previous.ref, score: previous.score, at: previous.startedAt, features: previous.features, lines: linesOfReport(previous.id) },
      current: { score: outcome.score, features: outcome.features, lines: outcome.findings.map((f) => ({ id: f.id, label: f.label, status: f.status, priority: f.priority })) },
    });
    const findings: AnalyzerFinding[] = [];
    const add = (lines: typeof diff.resolved, verb: string) => {
      for (const line of lines) findings.push({ message: `${verb}: ${line.label}`, evidence: line.status });
    };
    add(diff.appeared, "New problem");
    add(diff.worsened, "Got worse");
    add(diff.resolved, "Fixed");
    add(diff.improved, "Improved");
    add(diff.persistent, "Still open");
    if (diff.featuresAdded.length) findings.push({ message: `Checks added since then (plan change): ${diff.featuresAdded.slice(0, 8).map(featureLabel).join(", ")}${diff.featuresAdded.length > 8 ? "…" : ""}` });
    if (diff.featuresRemoved.length) findings.push({ message: `Checks no longer included: ${diff.featuresRemoved.slice(0, 8).map(featureLabel).join(", ")}${diff.featuresRemoved.length > 8 ? "…" : ""}` });
    if (diff.notCompared) findings.push({ message: `${diff.notCompared} line(s) ran in only one of the two scans and were not compared.` });

    const delta = diff.scoreDelta === 0 ? "unchanged" : `${diff.scoreDelta > 0 ? "+" : ""}${diff.scoreDelta}`;
    const summary = `Since ${previous.ref} on ${formatDate(previous.startedAt)}: score ${Math.round(previous.score)} → ${Math.round(outcome.score)} (${delta}); ${diff.resolved.length} fixed, ${diff.appeared.length} new, ${diff.worsened.length} worse, ${diff.persistent.length} still open.`;
    const regressed = diff.appeared.length + diff.worsened.length > 0;
    return {
      status: regressed ? "warn" : "pass",
      summary,
      findings,
      recommendation: regressed ? `Look at what changed first: ${[...diff.appeared, ...diff.worsened].slice(0, 3).map((l) => l.label).join(", ")}.` : "",
      confidence: "high",
    };
  },
};
