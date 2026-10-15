import type { FeatureVector } from "./features";

/**
 * The learning maths, in plain TypeScript: no I/O, no randomness, no
 * outside service. Given the same examples it always produces the same
 * model, which is what makes a training run reproducible and a promotion
 * decision checkable after the fact.
 *
 *   logistic regression  approved (1) vs rejected (0)
 *   softmax regression   which rejection reason, when there are enough
 *
 * Both are trained by full-batch gradient descent on standardised
 * features, with L2 regularisation (the bias is not regularised),
 * per-example weights (label trust × class balance) and a stop when the
 * loss stops improving. Every exp/log is guarded so extreme inputs give
 * finite numbers.
 */

export type Example = {
  id: string;
  /** Examples sharing a group (the domain) always land in the same split. */
  group: string;
  x: FeatureVector;
  /** 1 approved, 0 rejected. */
  y: 0 | 1;
  /** Trust in this label, 0–1 (see lib/ml/labels.ts). */
  weight: number;
  reason?: string | null;
};

export type Normalizer = {
  features: string[];
  mean: number[];
  std: number[];
  /** Share of training examples that had each feature (for the admin page). */
  coverage: number[];
};

export type Hyper = {
  lambda: number;
  learningRate: number;
  maxEpochs: number;
  tolerance: number;
};

export const DEFAULT_HYPER: Hyper = { lambda: 0.01, learningRate: 0.2, maxEpochs: 4000, tolerance: 1e-7 };

export type LogisticModel = {
  kind: "logistic";
  normalizer: Normalizer;
  weights: number[];
  bias: number;
  hyper: Hyper;
  epochs: number;
  converged: boolean;
  trainLoss: number;
};

export type SoftmaxModel = {
  kind: "softmax";
  classes: string[];
  normalizer: Normalizer;
  weights: number[][];
  bias: number[];
  hyper: Hyper;
  epochs: number;
  converged: boolean;
  trainLoss: number;
};

const Z_CLIP = 5;
const EPS = 1e-12;

/* ── numerics ───────────────────────────────────────────────────── */

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function clipP(p: number): number {
  return Math.min(1 - EPS, Math.max(EPS, p));
}

export function softmax(scores: number[]): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** FNV-1a, 32-bit: a stable hash for deterministic splitting. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/* ── features ───────────────────────────────────────────────────── */

/**
 * The features a model will use: present in at least `minCoverage` of the
 * training examples and not constant there, most common first, at most
 * `maxFeatures`. Ties are broken by name so the choice is reproducible.
 */
export function selectFeatures(examples: Example[], minCoverage = 0.25, maxFeatures = 200): string[] {
  const seen = new Map<string, { n: number; first: number; varies: boolean }>();
  for (const example of examples) {
    for (const [name, value] of Object.entries(example.x)) {
      const entry = seen.get(name);
      if (!entry) seen.set(name, { n: 1, first: value, varies: false });
      else {
        entry.n += 1;
        if (value !== entry.first) entry.varies = true;
      }
    }
  }
  const min = Math.max(1, Math.ceil(examples.length * minCoverage));
  return [...seen.entries()]
    .filter(([, e]) => e.n >= min && e.varies)
    .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxFeatures)
    .map(([name]) => name)
    .sort();
}

/** Mean and standard deviation of each feature over the examples that have it. */
export function fitNormalizer(examples: Example[], features: string[]): Normalizer {
  const mean: number[] = [];
  const std: number[] = [];
  const coverage: number[] = [];
  for (const name of features) {
    let n = 0;
    let sum = 0;
    for (const e of examples) {
      const v = e.x[name];
      if (v !== undefined) {
        n += 1;
        sum += v;
      }
    }
    const m = n > 0 ? sum / n : 0;
    let sq = 0;
    for (const e of examples) {
      const v = e.x[name];
      if (v !== undefined) sq += (v - m) ** 2;
    }
    const s = n > 1 ? Math.sqrt(sq / n) : 0;
    mean.push(m);
    std.push(s > 1e-9 ? s : 1);
    coverage.push(examples.length ? n / examples.length : 0);
  }
  return { features, mean, std, coverage };
}

/** Standardised row: (x − mean) / std, clipped to ±5; missing values become 0, the training mean. */
export function standardize(normalizer: Normalizer, x: FeatureVector): number[] {
  return normalizer.features.map((name, i) => {
    const v = x[name];
    if (v === undefined || !Number.isFinite(v)) return 0;
    const z = (v - normalizer.mean[i]!) / normalizer.std[i]!;
    return Math.max(-Z_CLIP, Math.min(Z_CLIP, z));
  });
}

/* ── splitting ──────────────────────────────────────────────────── */

/**
 * Train/validation split by group (domain): every scan of a site is on the
 * same side, so the model is never validated on a site it learned from.
 * Deterministic for a given seed, and stable as data grows — a site does
 * not move between sides when other sites are added.
 */
export function splitByGroup(examples: Example[], validationShare = 0.2, seed = "aec-ml-v1"): { train: Example[]; validation: Example[] } {
  const train: Example[] = [];
  const validation: Example[] = [];
  for (const example of examples) {
    const u = hash32(`${seed}:${example.group}`) / 0x1_0000_0000;
    (u < validationShare ? validation : train).push(example);
  }
  return { train, validation };
}

/* ── logistic regression ────────────────────────────────────────── */

/** Weights that give each class the same total influence, times label trust. */
export function balancedWeights(labels: number[], trust: number[]): number[] {
  const totals = new Map<number, number>();
  labels.forEach((y, i) => totals.set(y, (totals.get(y) ?? 0) + trust[i]!));
  const classes = totals.size;
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  return labels.map((y, i) => (trust[i]! * all) / (classes * Math.max(totals.get(y)!, EPS)));
}

export async function trainLogistic(train: Example[], normalizer: Normalizer, hyper: Hyper = DEFAULT_HYPER): Promise<LogisticModel> {
  const X = train.map((e) => standardize(normalizer, e.x));
  const y = train.map((e) => e.y);
  const w = balancedWeights(y, train.map((e) => e.weight));
  const wSum = w.reduce((a, b) => a + b, 0) || 1;
  const d = normalizer.features.length;
  const weights = new Array<number>(d).fill(0);
  let bias = 0;
  let previous = Infinity;
  let loss = Infinity;
  let epochs = 0;
  let converged = false;

  for (let epoch = 1; epoch <= hyper.maxEpochs; epoch += 1) {
    const grad = new Array<number>(d).fill(0);
    let gradBias = 0;
    loss = 0;
    for (let i = 0; i < X.length; i += 1) {
      const row = X[i]!;
      let z = bias;
      for (let j = 0; j < d; j += 1) z += weights[j]! * row[j]!;
      const p = sigmoid(z);
      const err = (p - y[i]!) * w[i]!;
      for (let j = 0; j < d; j += 1) grad[j]! += err * row[j]!;
      gradBias += err;
      const pc = clipP(p);
      loss -= w[i]! * (y[i]! * Math.log(pc) + (1 - y[i]!) * Math.log(1 - pc));
    }
    let penalty = 0;
    for (let j = 0; j < d; j += 1) {
      weights[j] = weights[j]! - hyper.learningRate * (grad[j]! / wSum + hyper.lambda * weights[j]!);
      penalty += weights[j]! ** 2;
    }
    bias -= hyper.learningRate * (gradBias / wSum);
    loss = loss / wSum + (hyper.lambda / 2) * penalty;
    epochs = epoch;
    if (!Number.isFinite(loss)) throw new Error("training diverged (loss is not finite)");
    if (Math.abs(previous - loss) < hyper.tolerance) {
      converged = true;
      break;
    }
    previous = loss;
    if (epoch % 50 === 0) await pause(); // keep the server responsive
  }
  return { kind: "logistic", normalizer, weights, bias, hyper, epochs, converged, trainLoss: loss };
}

export type Contribution = { feature: string; value: number | null; contribution: number };

export function predictLogistic(model: LogisticModel, x: FeatureVector): { probability: number; contributions: Contribution[] } {
  const row = standardize(model.normalizer, x);
  let z = model.bias;
  const contributions: Contribution[] = [];
  row.forEach((v, j) => {
    const c = model.weights[j]! * v;
    z += c;
    const name = model.normalizer.features[j]!;
    if (c !== 0) contributions.push({ feature: name, value: x[name] ?? null, contribution: c });
  });
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { probability: sigmoid(z), contributions };
}

/* ── softmax regression ─────────────────────────────────────────── */

export async function trainSoftmax(
  train: Array<{ x: FeatureVector; label: string; weight: number }>,
  classes: string[],
  normalizer: Normalizer,
  hyper: Hyper = DEFAULT_HYPER,
): Promise<SoftmaxModel> {
  const X = train.map((e) => standardize(normalizer, e.x));
  const yIdx = train.map((e) => classes.indexOf(e.label));
  if (yIdx.some((i) => i < 0)) throw new Error("an example's class is not in the class list");
  const w = balancedWeights(yIdx, train.map((e) => e.weight));
  const wSum = w.reduce((a, b) => a + b, 0) || 1;
  const k = classes.length;
  const d = normalizer.features.length;
  const W = Array.from({ length: k }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(k).fill(0);
  let previous = Infinity;
  let loss = Infinity;
  let epochs = 0;
  let converged = false;

  for (let epoch = 1; epoch <= hyper.maxEpochs; epoch += 1) {
    const G = Array.from({ length: k }, () => new Array<number>(d).fill(0));
    const gb = new Array<number>(k).fill(0);
    loss = 0;
    for (let i = 0; i < X.length; i += 1) {
      const row = X[i]!;
      const scores = W.map((wc, c) => wc.reduce((s, wj, j) => s + wj * row[j]!, b[c]!));
      const p = softmax(scores);
      for (let c = 0; c < k; c += 1) {
        const err = (p[c]! - (yIdx[i] === c ? 1 : 0)) * w[i]!;
        const gc = G[c]!;
        for (let j = 0; j < d; j += 1) gc[j]! += err * row[j]!;
        gb[c]! += err;
      }
      loss -= w[i]! * Math.log(clipP(p[yIdx[i]!]!));
    }
    let penalty = 0;
    for (let c = 0; c < k; c += 1) {
      const wc = W[c]!;
      for (let j = 0; j < d; j += 1) {
        wc[j] = wc[j]! - hyper.learningRate * (G[c]![j]! / wSum + hyper.lambda * wc[j]!);
        penalty += wc[j]! ** 2;
      }
      b[c] = b[c]! - hyper.learningRate * (gb[c]! / wSum);
    }
    loss = loss / wSum + (hyper.lambda / 2) * penalty;
    epochs = epoch;
    if (!Number.isFinite(loss)) throw new Error("training diverged (loss is not finite)");
    if (Math.abs(previous - loss) < hyper.tolerance) {
      converged = true;
      break;
    }
    previous = loss;
    if (epoch % 25 === 0) await pause();
  }
  return { kind: "softmax", classes, normalizer, weights: W, bias: b, hyper, epochs, converged, trainLoss: loss };
}

export function predictSoftmax(model: SoftmaxModel, x: FeatureVector): Array<{ label: string; probability: number }> {
  const row = standardize(model.normalizer, x);
  const scores = model.weights.map((wc, c) => wc.reduce((s, wj, j) => s + wj * row[j]!, model.bias[c]!));
  return softmax(scores)
    .map((probability, c) => ({ label: model.classes[c]!, probability }))
    .sort((a, b) => b.probability - a.probability);
}

/* ── evaluation ─────────────────────────────────────────────────── */

export type BinaryMetrics = {
  n: number;
  positives: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  auc: number;
  logLoss: number;
  brier: number;
  /** Expected calibration error over 10 equal-width bins. */
  ece: number;
  /** Log loss of always predicting the training approval rate. */
  baselineLogLoss: number;
};

/** Area under the ROC curve (Mann–Whitney, ties counted half). NaN when a class is missing. */
export function auc(p: number[], y: number[]): number {
  const pairs = p.map((v, i) => ({ v, y: y[i]! })).sort((a, b) => a.v - b.v);
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1]!.v === pairs[i]!.v) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (pairs[k]!.y === 1) rankSum += rank;
    i = j + 1;
  }
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (pos === 0 || neg === 0) return Number.NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function binaryMetrics(p: number[], y: number[], prior: number): BinaryMetrics {
  const n = y.length;
  let tp = 0, fp = 0, fn = 0, tn = 0, ll = 0, brier = 0, base = 0;
  const pr = clipP(prior);
  for (let i = 0; i < n; i += 1) {
    const pred = p[i]! >= 0.5 ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp += 1;
    else if (pred === 1) fp += 1;
    else if (y[i] === 1) fn += 1;
    else tn += 1;
    const pc = clipP(p[i]!);
    ll -= y[i] === 1 ? Math.log(pc) : Math.log(1 - pc);
    base -= y[i] === 1 ? Math.log(pr) : Math.log(1 - pr);
    brier += (p[i]! - y[i]!) ** 2;
  }
  // Calibration: within each probability bin, how far the average
  // prediction is from the share actually approved, weighted by bin size.
  let ece = 0;
  for (let b = 0; b < 10; b += 1) {
    const idx = p.map((v, i) => ({ v, i })).filter(({ v }) => (b === 9 ? v >= 0.9 : v >= b / 10 && v < (b + 1) / 10));
    if (idx.length === 0) continue;
    const meanP = idx.reduce((s, { v }) => s + v, 0) / idx.length;
    const rate = idx.reduce((s, { i }) => s + y[i]!, 0) / idx.length;
    ece += (idx.length / n) * Math.abs(meanP - rate);
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    n,
    positives: tp + fn,
    accuracy: n ? (tp + tn) / n : 0,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    auc: auc(p, y),
    logLoss: n ? ll / n : Number.NaN,
    brier: n ? brier / n : Number.NaN,
    ece,
    baselineLogLoss: n ? base / n : Number.NaN,
  };
}

export type MulticlassMetrics = {
  n: number;
  accuracy: number;
  macroF1: number;
  logLoss: number;
  baselineLogLoss: number;
};

export function multiclassMetrics(
  probs: Array<Array<{ label: string; probability: number }>>,
  truth: string[],
  classes: string[],
  prior: Record<string, number>,
): MulticlassMetrics {
  const n = truth.length;
  let correct = 0, ll = 0, base = 0;
  const tp = new Map<string, number>(), fp = new Map<string, number>(), fn = new Map<string, number>();
  probs.forEach((dist, i) => {
    const top = dist[0]!.label;
    const actual = truth[i]!;
    if (top === actual) {
      correct += 1;
      tp.set(actual, (tp.get(actual) ?? 0) + 1);
    } else {
      fp.set(top, (fp.get(top) ?? 0) + 1);
      fn.set(actual, (fn.get(actual) ?? 0) + 1);
    }
    ll -= Math.log(clipP(dist.find((d) => d.label === actual)?.probability ?? 0));
    base -= Math.log(clipP(prior[actual] ?? 0));
  });
  const f1s = classes.map((c) => {
    const t = tp.get(c) ?? 0;
    const precision = t + (fp.get(c) ?? 0) ? t / (t + (fp.get(c) ?? 0)) : 0;
    const recall = t + (fn.get(c) ?? 0) ? t / (t + (fn.get(c) ?? 0)) : 0;
    return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  });
  return {
    n,
    accuracy: n ? correct / n : 0,
    macroF1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0,
    logLoss: n ? ll / n : Number.NaN,
    baselineLogLoss: n ? base / n : Number.NaN,
  };
}
