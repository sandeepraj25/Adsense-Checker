/**
 * The insight keys, for the registry check in ../analyzers/index.ts. Kept
 * free of imports so that check never pulls the database into the engine.
 */
export const INSIGHT_REGISTRY = [
  { key: "approval_probability", category: "smart", scope: "site", defaultPlan: "pro" },
  { key: "rejection_reason_predictor", category: "smart", scope: "site", defaultPlan: "pro" },
  { key: "similar_sites_comparison", category: "smart", scope: "site", defaultPlan: "pro" },
  { key: "rescan_diff", category: "smart", scope: "site", defaultPlan: "pro" },
  { key: "readiness_timeline", category: "smart", scope: "site", defaultPlan: "pro" },
  { key: "scheduled_rescan", category: "smart", scope: "site", defaultPlan: "pro" },
] as const;

export const INSIGHT_KEYS: ReadonlySet<string> = new Set(INSIGHT_REGISTRY.map((entry) => entry.key));
