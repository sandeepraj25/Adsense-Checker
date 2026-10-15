import type { DatabaseSync } from "node:sqlite";

import { ANALYZER_CATALOG, type AnalyzerCatalogEntry } from "@/lib/analysis/analyzers/catalog";
import { PLAN_RANK, isPlanId } from "@/lib/plans";

/**
 * Gives each new analyzer feature its default plan mapping — once.
 *
 * The first time the app starts with a feature key it has never seen, that
 * key is added to its default plan and every plan above it (higher tiers
 * are cumulative), and the key is recorded in app_settings
 * ("features.seeded"). From then on the administrator owns the mapping:
 * if they take the feature off a plan, no later start or deploy puts it
 * back, and existing keys are never touched.
 *
 * Runs inside one transaction at database open, after the plans are seeded.
 * On a fresh database the plan rows already carry the defaults (they are
 * seeded from lib/plans.ts), so this only records the keys.
 */

export const SEEDED_FEATURES_KEY = "features.seeded";

const CATALOG: readonly AnalyzerCatalogEntry[] = ANALYZER_CATALOG;

export function seedFeatureMappings(db: DatabaseSync, catalog: readonly AnalyzerCatalogEntry[] = CATALOG, now = Date.now()): string[] {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SEEDED_FEATURES_KEY) as { value?: string } | undefined;
  let seeded: string[] = [];
  try {
    const parsed: unknown = row?.value ? JSON.parse(row.value) : [];
    if (Array.isArray(parsed)) seeded = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // A damaged record must not re-seed everything over an admin's choices;
    // keep it as-is and seed nothing this time.
    console.error("[features] features.seeded setting is unreadable; skipping feature seeding");
    return [];
  }

  const pending = catalog.filter((entry) => !seeded.includes(entry.key));
  if (pending.length === 0) return [];

  const plans = db.prepare("SELECT id, features_json FROM plans").all() as Array<{ id: string; features_json: string }>;
  // Only the feature list moves: "last edited by" stays the admin's.
  const update = db.prepare("UPDATE plans SET features_json = ? WHERE id = ?");

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const plan of plans) {
      if (!isPlanId(plan.id)) continue;
      let features: unknown;
      try {
        features = JSON.parse(plan.features_json);
      } catch {
        continue;
      }
      if (!Array.isArray(features)) continue;
      const add = pending
        .filter((entry) => PLAN_RANK[plan.id as keyof typeof PLAN_RANK] >= PLAN_RANK[entry.defaultPlan])
        .map((entry) => entry.key)
        .filter((key) => !features.includes(key));
      if (add.length === 0) continue;
      update.run(JSON.stringify([...features, ...add]), plan.id);
    }
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(SEEDED_FEATURES_KEY, JSON.stringify([...seeded, ...pending.map((entry) => entry.key)]), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return pending.map((entry) => entry.key);
}
