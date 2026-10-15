import { createHash } from "node:crypto";

import { MIN_LABELED_EXAMPLES, MIN_PER_CLASS } from "./constants";
import { FEATURE_SCHEMA, parseVector } from "./features";
import { labelWeights } from "./labels";
import {
  binaryMetrics,
  DEFAULT_HYPER,
  fitNormalizer,
  multiclassMetrics,
  predictLogistic,
  predictSoftmax,
  selectFeatures,
  splitByGroup,
  trainLogistic,
  trainSoftmax,
  type BinaryMetrics,
  type Example,
  type SoftmaxModel,
} from "./model";
import { resetModelCache } from "./predict";
import {
  acquireTrainingLock,
  activateVersion,
  activeModelRow,
  findModelVersion,
  findVersionByName,
  insertModelVersion,
  labelledRows,
  markTrainingAttempt,
  recordEvent,
  releaseTrainingLock,
  saveLabelWeights,
  setTrainingStage,
  toModelVersion,
  type StoredMetrics,
} from "./store";

/**
 * One training run, start to finish:
 *
 *   1. take the lock (one run at a time, across processes)
 *   2. weigh every label by the published rules (lib/ml/labels.ts)
 *   3. stop, with a recorded reason, below 200 usable labels or 30 of
 *      either outcome — rule-based estimates stay in use
 *   4. split by site, train the approval model, evaluate on the held-out
 *      sites, and evaluate the active model on exactly the same sites
 *   5. train the rejection-reason model if there is enough to learn from
 *   6. store the candidate with its metrics and the decision, and promote
 *      it only when every acceptance criterion holds
 *
 * Every outcome — trained, promoted, not promoted, skipped or failed — is
 * written to ml_events, so a failed night is visible, not silent.
 */

export const VALIDATION_SHARE = 0.2;
export const SPLIT_SEED = "aec-ml-v1";
const LOCK_TTL_MS = 15 * 60_000;

/** Acceptance criteria. Changing these is a deliberate, reviewed decision. */
export const ACCEPTANCE = {
  minValidation: 40,
  minAuc: 0.6,
  /** Must beat always predicting the training approval rate by this much log loss. */
  minBaselineGain: 0.01,
  maxEce: 0.15,
  /** Versus the active model on the same validation sites. */
  maxLogLossRegression: 0.02,
  maxAucRegression: 0.02,
};

const REASON_MIN_EXAMPLES = 100;
const REASON_MIN_PER_CLASS = 15;

export type TrainingResult =
  | { outcome: "busy"; message: string }
  | { outcome: "skipped"; message: string }
  | { outcome: "failed"; message: string }
  | { outcome: "promoted" | "not_promoted"; message: string; version: string; id: string };

type Trigger = "nightly" | "manual" | "cron" | "test";

function round(n: number, places = 4): number {
  return Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : n;
}

function roundMetrics<T extends Record<string, number>>(m: T): T {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)])) as T;
}

function versionName(now: number, snapshot: string): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `v${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${snapshot.slice(0, 6)}`;
}

export async function runTraining(options: { trigger: Trigger; actor?: string | null; now?: number }): Promise<TrainingResult> {
  const now = options.now ?? Date.now();
  const owner = `${options.trigger}:${process.pid}:${now}`;
  if (!acquireTrainingLock(owner, LOCK_TTL_MS, now)) {
    return { outcome: "busy", message: "A training run is already in progress." };
  }
  markTrainingAttempt(now);
  const log = (event: Parameters<typeof recordEvent>[0]["event"], detail: string, modelVersionId?: string) =>
    recordEvent({ event, detail, trigger: options.trigger, actor: options.actor ?? null, modelVersionId, now: Date.now() });

  try {
    setTrainingStage("Weighing labels");
    const rows = labelledRows(FEATURE_SCHEMA);
    const weights = labelWeights(
      rows.map((r) => ({ id: r.id, userId: r.user_id, domain: r.domain, label: r.label!, labelStatus: r.label_status, labeledAt: r.labeled_at ?? r.created_at })),
    );
    saveLabelWeights(weights);
    const weightOf = new Map(weights.map((w) => [w.id, w.weight]));

    // One example per (site, outcome, identical numbers): a site scanned
    // twice with no change is one observation, not two.
    let examples: Example[] = [];
    const seen = new Set<string>();
    let duplicatesDropped = 0;
    for (const row of [...rows].reverse()) {
      const weight = weightOf.get(row.id) ?? 0;
      if (weight <= 0 || !row.label) continue;
      const x = parseVector(row.vector_json);
      const key = `${row.domain}|${row.label}|${createHash("sha1").update(JSON.stringify(x)).digest("hex")}`;
      if (seen.has(key)) {
        duplicatesDropped += 1;
        continue;
      }
      seen.add(key);
      examples.push({ id: row.id, group: row.domain, x, y: row.label === "approved" ? 1 : 0, weight, reason: row.rejection_reason });
    }
    examples = examples.sort((a, b) => (a.id < b.id ? -1 : 1)); // reproducible order

    const approved = examples.filter((e) => e.y === 1).length;
    const rejected = examples.length - approved;
    if (examples.length < MIN_LABELED_EXAMPLES || approved < MIN_PER_CLASS || rejected < MIN_PER_CLASS) {
      const message = `${examples.length} usable labels (${approved} approved, ${rejected} rejected). A trained model needs at least ${MIN_LABELED_EXAMPLES}, with ${MIN_PER_CLASS} of each outcome; estimates stay rule-based until then.`;
      log("skipped", message);
      return { outcome: "skipped", message };
    }

    const snapshot = createHash("sha256")
      .update(examples.map((e) => `${e.id}:${e.y}:${e.weight}:${e.reason ?? ""}`).join("\n"))
      .digest("hex")
      .slice(0, 16);
    const activeRow = activeModelRow();
    if (activeRow && activeRow.dataset_snapshot === snapshot && options.trigger !== "manual") {
      const message = `No new or changed labels since ${activeRow.version}; nothing to retrain.`;
      log("skipped", message);
      return { outcome: "skipped", message };
    }

    setTrainingStage("Splitting by site");
    const { train, validation } = splitByGroup(examples, VALIDATION_SHARE, SPLIT_SEED);
    const groups = new Set(examples.map((e) => e.group)).size;
    const classesIn = (set: Example[]) => new Set(set.map((e) => e.y)).size;
    if (validation.length < ACCEPTANCE.minValidation || classesIn(validation) < 2 || classesIn(train) < 2) {
      const message = `Not enough distinct sites to validate: ${validation.length} validation examples (need ${ACCEPTANCE.minValidation}, with both outcomes).`;
      log("skipped", message);
      return { outcome: "skipped", message };
    }

    const features = selectFeatures(train);
    if (features.length < 3) {
      const message = `Only ${features.length} features vary across the training sites; nothing to learn from yet.`;
      log("skipped", message);
      return { outcome: "skipped", message };
    }

    setTrainingStage(`Training approval model on ${train.length} examples`);
    const normalizer = fitNormalizer(train, features);
    const model = await trainLogistic(train, normalizer, DEFAULT_HYPER);

    setTrainingStage("Evaluating");
    const trainWeight = train.reduce((s, e) => s + e.weight, 0);
    const prior = train.reduce((s, e) => s + e.y * e.weight, 0) / trainWeight;
    const evaluate = (predict: (e: Example) => number, set: Example[]) => roundMetrics(binaryMetrics(set.map(predict), set.map((e) => e.y), prior));
    const vMetrics = evaluate((e) => predictLogistic(model, e.x).probability, validation);
    const tMetrics = evaluate((e) => predictLogistic(model, e.x).probability, train);

    let previous: (BinaryMetrics & { version: string }) | null = null;
    if (activeRow) {
      try {
        const active = toModelVersion(activeRow);
        previous = { ...evaluate((e) => predictLogistic(active.model, e.x).probability, validation), version: active.version };
      } catch (error) {
        log("failed", `The active model ${activeRow.version} could not be evaluated for comparison (${error instanceof Error ? error.message : error}); judging the candidate on its own criteria.`);
      }
    }

    const criteria: StoredMetrics["criteria"] = [
      { name: "Validation size", ok: vMetrics.n >= ACCEPTANCE.minValidation, detail: `${vMetrics.n} examples (minimum ${ACCEPTANCE.minValidation})` },
      { name: "Ranking (AUC)", ok: vMetrics.auc >= ACCEPTANCE.minAuc, detail: `${vMetrics.auc} (minimum ${ACCEPTANCE.minAuc})` },
      {
        name: "Better than the base rate",
        ok: vMetrics.logLoss <= vMetrics.baselineLogLoss - ACCEPTANCE.minBaselineGain,
        detail: `log loss ${vMetrics.logLoss} vs ${vMetrics.baselineLogLoss} for always guessing the approval rate`,
      },
      { name: "Calibration (ECE)", ok: vMetrics.ece <= ACCEPTANCE.maxEce, detail: `${vMetrics.ece} (maximum ${ACCEPTANCE.maxEce})` },
    ];
    if (previous) {
      criteria.push({
        name: `No regression vs ${previous.version}`,
        ok: vMetrics.logLoss <= previous.logLoss + ACCEPTANCE.maxLogLossRegression && vMetrics.auc >= previous.auc - ACCEPTANCE.maxAucRegression,
        detail: `log loss ${vMetrics.logLoss} vs ${previous.logLoss}; AUC ${vMetrics.auc} vs ${previous.auc}`,
      });
    }

    setTrainingStage("Training rejection-reason model");
    const reasonPart = await trainReasons(train, validation, features);

    const metrics: StoredMetrics = {
      validation: vMetrics,
      train: tMetrics,
      previous,
      criteria,
      reasons: reasonPart.metrics,
      dataset: {
        usable: examples.length,
        approved,
        rejected,
        groups,
        trainGroups: new Set(train.map((e) => e.group)).size,
        validationGroups: new Set(validation.map((e) => e.group)).size,
        duplicatesDropped,
      },
      features: features.length,
    };
    const accept = criteria.every((c) => c.ok);
    const decision = accept
      ? "Promoted: every acceptance criterion passed."
      : `Not promoted: ${criteria.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`).join("; ")}.`;
    let version = versionName(now, snapshot);
    for (let n = 2; findVersionByName(version); n += 1) version = `${versionName(now, snapshot)}.${n}`;
    const id = insertModelVersion({
      version,
      algorithm: reasonPart.model ? "logistic_regression_gd+softmax_gd" : "logistic_regression_gd",
      featureSchema: FEATURE_SCHEMA,
      model,
      reasonModel: reasonPart.model,
      datasetSnapshot: snapshot,
      trainCount: train.length,
      validationCount: validation.length,
      metrics,
      decision,
      status: accept ? "candidate" : "rejected",
      now,
    });
    log("trained", `${version}: ${train.length} train / ${validation.length} validation examples, ${features.length} features, ${model.epochs} epochs${model.converged ? "" : " (stopped at the epoch limit)"}; AUC ${vMetrics.auc}, log loss ${vMetrics.logLoss}.`, id);

    if (accept) {
      const { previous: replaced } = activateVersion(id, Date.now());
      resetModelCache();
      log("promoted", `${version} is now active${replaced ? `, replacing ${replaced} (kept for rollback)` : ""}.`, id);
      return { outcome: "promoted", message: `${version} promoted.`, version, id };
    }
    log("not_promoted", decision, id);
    return { outcome: "not_promoted", message: decision, version, id };
  } catch (error) {
    const message = `Training failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    console.error(`[ml] ${message}`);
    try {
      log("failed", message);
    } catch {
      /* the log itself failed; the console line above is the record */
    }
    return { outcome: "failed", message };
  } finally {
    setTrainingStage("idle");
    releaseTrainingLock(owner);
  }
}

/**
 * The rejection-reason model, trained on rejected examples only. Reasons
 * with too few examples are pooled into "other"; with fewer than two
 * real classes or 100 reasons there is nothing reliable to learn, and the
 * run says so instead of storing a model.
 */
async function trainReasons(
  train: Example[],
  validation: Example[],
  features: string[],
): Promise<{ model: SoftmaxModel | null; metrics: StoredMetrics["reasons"] }> {
  const withReason = (set: Example[]) => set.filter((e) => e.y === 0).map((e) => ({ x: e.x, label: e.reason || "other", weight: e.weight }));
  const tr = withReason(train);
  const va = withReason(validation);
  const empty = (note: string): StoredMetrics["reasons"] => ({ n: va.length, accuracy: 0, macroF1: 0, logLoss: Number.NaN, baselineLogLoss: Number.NaN, classes: [], used: false, note });
  if (tr.length + va.length < REASON_MIN_EXAMPLES) {
    return { model: null, metrics: empty(`${tr.length + va.length} rejected examples with reasons; the reason model needs ${REASON_MIN_EXAMPLES}.`) };
  }
  const counts = new Map<string, number>();
  for (const e of tr) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
  const kept = [...counts.entries()].filter(([label, n]) => n >= REASON_MIN_PER_CLASS && label !== "other").map(([label]) => label).sort();
  if (kept.length < 2) {
    return { model: null, metrics: empty(`Fewer than two reasons have ${REASON_MIN_PER_CLASS} training examples each.`) };
  }
  const classes = [...kept, "other"];
  const pool = (label: string) => (kept.includes(label) ? label : "other");
  const trainSet = tr.map((e) => ({ ...e, label: pool(e.label) }));
  const validSet = va.map((e) => ({ ...e, label: pool(e.label) }));
  if (validSet.length < 10) {
    return { model: null, metrics: empty(`Only ${validSet.length} rejected validation examples; the reason model needs 10 to be checked.`) };
  }
  const normalizer = fitNormalizer(trainSet.map((e, i) => ({ id: String(i), group: "", x: e.x, y: 0, weight: e.weight })), features);
  const model = await trainSoftmax(trainSet, classes, normalizer, DEFAULT_HYPER);
  const total = trainSet.reduce((s, e) => s + e.weight, 0);
  const prior = Object.fromEntries(classes.map((c) => [c, trainSet.filter((e) => e.label === c).reduce((s, e) => s + e.weight, 0) / total]));
  const m = multiclassMetrics(validSet.map((e) => predictSoftmax(model, e.x)), validSet.map((e) => e.label), classes, prior);
  const used = m.logLoss < m.baselineLogLoss;
  return {
    model: used ? model : null,
    metrics: {
      ...roundMetrics(m),
      classes,
      used,
      note: used ? "Beats the reason base rates on held-out sites." : "Did not beat the reason base rates on held-out sites, so reasons are not predicted.",
    },
  };
}

/** Rollback: make an earlier, previously active version active again. */
export function rollbackTo(id: string, actor: string, now = Date.now()): { ok: true; version: string; replaced: string | null } | { ok: false; message: string } {
  if (activeModelRow()?.id === id) return { ok: false, message: "That version is already active." };
  const found = findModelVersion(id);
  const candidate = found ? toModelVersion(found) : null;
  if (!candidate) return { ok: false, message: "Model version not found." };
  if (candidate.status !== "retired") {
    return { ok: false, message: "Only a version that was active before can be restored. Versions that failed their acceptance checks cannot be activated." };
  }
  const { previous } = activateVersion(id, now);
  resetModelCache();
  recordEvent({ event: "rolled_back", trigger: "manual", actor, modelVersionId: id, detail: `${candidate.version} restored${previous ? `, replacing ${previous}` : ""}.`, now });
  return { ok: true, version: candidate.version, replaced: previous };
}
