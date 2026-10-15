import { many, one, run, tx } from "@/lib/db";
import { newId } from "@/lib/ids";

import type { BinaryMetrics, LogisticModel, MulticlassMetrics, SoftmaxModel } from "./model";

/**
 * Storage for the prediction system: scan feature rows, model versions,
 * the training event log and the training lock. All SQL for lib/ml that
 * is not about feedback lives here.
 */

/* ── scan features ──────────────────────────────────────────────── */

export function insertScanFeatures(input: {
  reportId: string;
  userId: string;
  domain: string;
  planId: string;
  analysisMode: string;
  featureSchema: string;
  vector: Record<string, number>;
  modelVersion: string | null;
  estimate: unknown;
  /** Broad subject (lib/analysis/niche.ts), for like-for-like comparisons. */
  niche?: string | null;
  now?: number;
}): boolean {
  return (
    run(
      `INSERT OR IGNORE INTO scan_features
         (id, report_id, user_id, domain, plan_id, analysis_mode, feature_schema, feature_count, vector_json, model_version, estimate_json, niche, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("sfv"),
        input.reportId,
        input.userId,
        input.domain,
        input.planId,
        input.analysisMode,
        input.featureSchema,
        Object.keys(input.vector).length,
        JSON.stringify(input.vector),
        input.modelVersion,
        input.estimate === undefined ? null : JSON.stringify(input.estimate),
        input.niche ?? null,
        input.now ?? Date.now(),
      ],
    ).changes === 1
  );
}

export type ScanFeatureRow = {
  id: string;
  report_id: string;
  user_id: string;
  domain: string;
  plan_id: string;
  analysis_mode: string;
  feature_schema: string;
  feature_count: number;
  vector_json: string;
  model_version: string | null;
  estimate_json: string | null;
  label: "approved" | "rejected" | null;
  rejection_reason: string | null;
  label_source: string | null;
  label_status: "none" | "accepted" | "deferred" | "superseded" | "excluded";
  label_weight: number;
  weight_note: string | null;
  labeled_at: number | null;
  niche: string | null;
  created_at: number;
};

export function scanFeaturesForReport(reportId: string): ScanFeatureRow | null {
  return one<ScanFeatureRow>("SELECT * FROM scan_features WHERE report_id = ?", [reportId]);
}

/** Labelled rows the trainer may use (accepted or not — weights decide). */
export function labelledRows(featureSchema: string): ScanFeatureRow[] {
  return many<ScanFeatureRow>(
    `SELECT * FROM scan_features
      WHERE label IS NOT NULL AND label_status <> 'none' AND analysis_mode = 'live' AND feature_schema = ?
      ORDER BY created_at ASC`,
    [featureSchema],
  );
}

export function saveLabelWeights(weights: Array<{ id: string; weight: number; notes: string[] }>): void {
  tx(() => {
    for (const w of weights) {
      run("UPDATE scan_features SET label_weight = ?, weight_note = ? WHERE id = ?", [w.weight, w.notes.join(" ") || null, w.id]);
    }
  });
}

export type LabelStats = {
  scans: number;
  labelled: number;
  usable: number;
  approved: number;
  rejected: number;
  deferred: number;
  superseded: number;
  reduced: number;
  reasons: Array<{ reason: string; n: number }>;
};

export function labelStats(featureSchema: string): LabelStats {
  const scans = one<{ n: number }>("SELECT COUNT(*) AS n FROM scan_features")?.n ?? 0;
  const rows = many<{ label_status: string; label: string | null; n: number; reduced: number; usable: number }>(
    `SELECT label_status, label, COUNT(*) AS n,
            SUM(CASE WHEN label_weight < 1 THEN 1 ELSE 0 END) AS reduced,
            SUM(CASE WHEN label_weight > 0 AND analysis_mode = 'live' AND feature_schema = ? THEN 1 ELSE 0 END) AS usable
       FROM scan_features WHERE label IS NOT NULL GROUP BY label_status, label`,
    [featureSchema],
  );
  const stats: LabelStats = { scans, labelled: 0, usable: 0, approved: 0, rejected: 0, deferred: 0, superseded: 0, reduced: 0, reasons: [] };
  for (const r of rows) {
    stats.labelled += r.n;
    if (r.label_status === "accepted") {
      stats.usable += r.usable;
      stats.reduced += r.reduced;
      if (r.label === "approved") stats.approved += r.n;
      if (r.label === "rejected") stats.rejected += r.n;
    }
    if (r.label_status === "deferred") stats.deferred += r.n;
    if (r.label_status === "superseded") stats.superseded += r.n;
  }
  stats.reasons = many<{ reason: string; n: number }>(
    `SELECT COALESCE(rejection_reason, 'other') AS reason, COUNT(*) AS n FROM scan_features
      WHERE label = 'rejected' AND label_status = 'accepted' GROUP BY 1 ORDER BY n DESC`,
  );
  return stats;
}

/* ── model versions ─────────────────────────────────────────────── */

export type ModelStatus = "candidate" | "active" | "rejected" | "retired";

export type StoredMetrics = {
  validation: BinaryMetrics;
  train: BinaryMetrics;
  /** The active model's metrics on the same validation set, when there was one. */
  previous: (BinaryMetrics & { version: string }) | null;
  criteria: Array<{ name: string; ok: boolean; detail: string }>;
  reasons: (MulticlassMetrics & { classes: string[]; used: boolean; note: string }) | null;
  dataset: { usable: number; approved: number; rejected: number; groups: number; trainGroups: number; validationGroups: number; duplicatesDropped: number };
  features: number;
};

export type ModelVersionRow = {
  id: string;
  version: string;
  algorithm: string;
  feature_schema: string;
  status: ModelStatus;
  model_json: string;
  reason_model_json: string | null;
  dataset_snapshot: string;
  train_count: number;
  validation_count: number;
  metrics_json: string;
  decision: string | null;
  trained_at: number;
  activated_at: number | null;
  retired_at: number | null;
};

export type ModelVersion = {
  id: string;
  version: string;
  algorithm: string;
  featureSchema: string;
  status: ModelStatus;
  model: LogisticModel;
  reasonModel: SoftmaxModel | null;
  datasetSnapshot: string;
  trainCount: number;
  validationCount: number;
  metrics: StoredMetrics;
  decision: string | null;
  trainedAt: number;
  activatedAt: number | null;
  retiredAt: number | null;
};

export function toModelVersion(row: ModelVersionRow): ModelVersion {
  return {
    id: row.id,
    version: row.version,
    algorithm: row.algorithm,
    featureSchema: row.feature_schema,
    status: row.status,
    model: JSON.parse(row.model_json) as LogisticModel,
    reasonModel: row.reason_model_json ? (JSON.parse(row.reason_model_json) as SoftmaxModel) : null,
    datasetSnapshot: row.dataset_snapshot,
    trainCount: row.train_count,
    validationCount: row.validation_count,
    metrics: JSON.parse(row.metrics_json) as StoredMetrics,
    decision: row.decision,
    trainedAt: row.trained_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
  };
}

export function insertModelVersion(input: {
  version: string;
  algorithm: string;
  featureSchema: string;
  model: LogisticModel;
  reasonModel: SoftmaxModel | null;
  datasetSnapshot: string;
  trainCount: number;
  validationCount: number;
  metrics: StoredMetrics;
  decision: string;
  status: "candidate" | "rejected";
  now: number;
}): string {
  const id = newId("mdl");
  run(
    `INSERT INTO model_versions
       (id, version, algorithm, feature_schema, status, model_json, reason_model_json, dataset_snapshot,
        train_count, validation_count, metrics_json, decision, trained_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.version,
      input.algorithm,
      input.featureSchema,
      input.status,
      JSON.stringify(input.model),
      input.reasonModel ? JSON.stringify(input.reasonModel) : null,
      input.datasetSnapshot,
      input.trainCount,
      input.validationCount,
      JSON.stringify(input.metrics),
      input.decision,
      input.now,
    ],
  );
  return id;
}

/** Makes one version active and retires the one it replaces, atomically. */
export function activateVersion(id: string, now = Date.now()): { previous: string | null } {
  return tx(() => {
    const previous = one<{ id: string; version: string }>("SELECT id, version FROM model_versions WHERE status = 'active'");
    if (previous?.id === id) return { previous: null };
    if (previous) run("UPDATE model_versions SET status = 'retired', retired_at = ? WHERE id = ?", [now, previous.id]);
    const changed = run("UPDATE model_versions SET status = 'active', activated_at = ?, retired_at = NULL WHERE id = ?", [now, id]).changes;
    if (changed !== 1) throw new Error("model version not found");
    return { previous: previous?.version ?? null };
  });
}

export function activeModelRow(): ModelVersionRow | null {
  return one<ModelVersionRow>("SELECT * FROM model_versions WHERE status = 'active'");
}

export function activeModelId(): string | null {
  return one<{ id: string }>("SELECT id FROM model_versions WHERE status = 'active'")?.id ?? null;
}

export function findModelVersion(id: string): ModelVersionRow | null {
  return one<ModelVersionRow>("SELECT * FROM model_versions WHERE id = ?", [id]);
}

export function findVersionByName(version: string): boolean {
  return one<{ id: string }>("SELECT id FROM model_versions WHERE version = ?", [version]) !== null;
}

export function listModelVersions(limit = 20): ModelVersionRow[] {
  return many<ModelVersionRow>("SELECT * FROM model_versions ORDER BY trained_at DESC, rowid DESC LIMIT ?", [limit]);
}

/* ── events ─────────────────────────────────────────────────────── */

export type MlEvent = {
  id: string;
  model_version_id: string | null;
  event: "trained" | "promoted" | "not_promoted" | "skipped" | "failed" | "rolled_back";
  trigger: string;
  actor: string | null;
  detail: string;
  created_at: number;
};

export function recordEvent(input: { modelVersionId?: string | null; event: MlEvent["event"]; trigger: string; actor?: string | null; detail: string; now?: number }): void {
  run(
    "INSERT INTO ml_events (id, model_version_id, event, trigger, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [newId("mle"), input.modelVersionId ?? null, input.event, input.trigger, input.actor ?? null, input.detail.slice(0, 2000), input.now ?? Date.now()],
  );
}

export function listEvents(limit = 30): MlEvent[] {
  return many<MlEvent>("SELECT * FROM ml_events ORDER BY created_at DESC, rowid DESC LIMIT ?", [limit]);
}

/* ── settings: lock and last run ────────────────────────────────── */

const LOCK_KEY = "ml.training_lock";
const LAST_KEY = "ml.last_training_attempt";
const STATE_KEY = "ml.training_state";

/**
 * One training run at a time, across processes: a guarded upsert that
 * only succeeds when no unexpired lock exists. A crashed run's lock simply
 * expires.
 */
export function acquireTrainingLock(owner: string, ttlMs: number, now = Date.now()): boolean {
  const until = String(now + ttlMs);
  return (
    run(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
       WHERE CAST(app_settings.value AS INTEGER) < ?`,
      [LOCK_KEY, until, now, owner, now],
    ).changes === 1
  );
}

export function releaseTrainingLock(owner: string): void {
  run("UPDATE app_settings SET value = '0' WHERE key = ? AND updated_by = ?", [LOCK_KEY, owner]);
}

export function trainingRunning(now = Date.now()): { since: number; by: string | null } | null {
  const row = one<{ value: string; updated_at: number; updated_by: string | null }>(
    "SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?",
    [LOCK_KEY],
  );
  return row && Number(row.value) > now ? { since: row.updated_at, by: row.updated_by } : null;
}

function setSetting(key: string, value: string, now: number, by = "system"): void {
  run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, value, now, by],
  );
}

export function markTrainingAttempt(now: number): void {
  setSetting(LAST_KEY, String(now), now);
}

export function lastTrainingAttempt(): number | null {
  const value = one<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", [LAST_KEY])?.value;
  return value ? Number(value) || null : null;
}

export function setTrainingStage(stage: string, now = Date.now()): void {
  setSetting(STATE_KEY, stage, now);
}

export function trainingStage(): { stage: string; at: number } | null {
  const row = one<{ value: string; updated_at: number }>("SELECT value, updated_at FROM app_settings WHERE key = ?", [STATE_KEY]);
  return row ? { stage: row.value, at: row.updated_at } : null;
}
