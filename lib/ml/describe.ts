import { ANALYZER_CATALOG } from "@/lib/analysis/analyzers/catalog";
import { CHECKS } from "@/lib/analysis/checks";
import { CATEGORY_META, type CategoryKey } from "@/lib/analysis/types";

/**
 * Plain-English names for feature-vector entries, for the admin page and
 * for the "factors" an estimate lists. Unknown names fall back to the raw
 * name rather than guessing.
 */

const CORE: Record<string, string> = {
  "core.score": "Overall readiness score",
  "core.passed": "Checks passed",
  "core.warnings": "Warnings",
  "core.critical": "High-priority failures",
  "core.pages": "Pages read",
  "core.partial": "Scan hit its time limit",
};

const METRIC: Record<string, string> = {
  totalwords: "Total words",
  averagewords: "Average words per page",
  ailikelihood: "Machine-written likelihood",
  humansignalscore: "Human-writing signals",
  originality: "Originality",
  duplicatepairs: "Near-duplicate page pairs",
  duplicateshare: "Share of near-duplicate pages",
  addensity: "Ad density",
  adslots: "Ad slots",
  sitemapurls: "Sitemap URLs",
  maxdepth: "Deepest click depth",
  averagedepth: "Average click depth",
  orphanpages: "Orphan pages",
  brokenlinks: "Broken links",
  aireliable: "Machine-writing estimate reliable",
};

const checkLabels = new Map(CHECKS.map((c) => [c.id.replace(/-/g, "_"), c.label]));
const analyzerLabels = new Map<string, string>(ANALYZER_CATALOG.map((a) => [a.key, a.label]));

export function describeFeature(name: string): string {
  if (CORE[name]) return CORE[name]!;
  const [head, ...rest] = name.split(".");
  if (head === "cat") return `${CATEGORY_META[rest[0] as CategoryKey]?.name ?? rest[0]} score`;
  if (head === "check") return checkLabels.get(rest.join(".")) ?? name;
  if (head === "metric") return METRIC[rest.join(".")] ?? name;
  if (head === "az") {
    const label = analyzerLabels.get(rest[0] ?? "");
    if (!label) return name;
    const signal = rest.slice(1).join(".");
    return signal === "status" ? `${label} (result)` : `${label}: ${signal.replace(/_/g, " ")}`;
  }
  return name;
}
