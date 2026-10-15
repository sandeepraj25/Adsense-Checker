// Phase 3: the self-learning approval model (lib/ml) — maths, data
// collection, feedback rules, training, promotion, rollback and the
// database upgrade — against the real compiled lib/ and a throwaway
// database. No network.
//
//     node --test scripts/ml-test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_ENV = "test";
process.env.EMAIL_PROVIDER = "console";
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD"]) delete process.env[name];

const lib = compileLib(projectRoot, "aec-ml-");
process.env.DATA_DIR = path.join(lib.workDir, "data");
process.on("exit", () => lib.cleanup());
const req = lib.require;

const model = req("./ml/model.js");
const { buildFeatureVector, sanitizeVector, FEATURE_SCHEMA } = req("./ml/features.js");
const { ruleBasedEstimate } = req("./ml/rules.js");
const { labelWeights } = req("./ml/labels.js");
const store = req("./ml/store.js");
const feedback = req("./ml/feedback.js");
const { processFeedbackEmails } = req("./ml/feedback-email.js");
const { collectScanFeatures } = req("./ml/collect.js");
const { estimateApproval, resetModelCache } = req("./ml/predict.js");
const { runTraining, rollbackTo } = req("./ml/train.js");
const { trainingDue } = req("./ml/job.js");
const { getDb, run, one, many } = req("./db/index.js");
const { MIGRATIONS } = req("./db/schema.js");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic world with a known rule: high score and few critical failures get approved. */
function synthetic(n, seed = 7, { noise = 0.6, randomLabels = false } = {}) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const score = Math.round(30 + r() * 65);
    const critical = Math.floor(r() * 6);
    const irrelevant = r() * 10;
    const z = 0.12 * (score - 62) - 0.9 * (critical - 2.5) + noise * (r() * 2 - 1) * 2;
    const y = randomLabels ? (r() < 0.5 ? 1 : 0) : z > 0 ? 1 : 0;
    const x = { "core.score": score, "core.critical": critical, "metric.irrelevant": irrelevant };
    if (r() < 0.7) x["az.hidden_text.status"] = critical > 3 ? 0 : 1; // present on "Pro" scans only
    out.push({ id: `e${String(i).padStart(4, "0")}`, group: `site${i}.test`, x, y, weight: 1, reason: y ? null : ["low_value_content", "navigation", "policy_violation"][i % 3] });
  }
  return out;
}

/* ── maths ──────────────────────────────────────────────────────── */

test("sigmoid and softmax stay finite and correct at extreme inputs", () => {
  assert.equal(model.sigmoid(0), 0.5);
  assert.ok(model.sigmoid(1000) === 1 && model.sigmoid(-1000) >= 0 && Number.isFinite(model.sigmoid(-1000)));
  const p = model.softmax([1000, 1000, -1000]);
  assert.ok(p.every(Number.isFinite));
  assert.ok(Math.abs(p[0] - 0.5) < 1e-12 && Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test("logistic regression recovers a known rule, and validates well on unseen sites", async () => {
  const data = synthetic(600);
  const { train, validation } = model.splitByGroup(data, 0.2, "t");
  const features = model.selectFeatures(train);
  const norm = model.fitNormalizer(train, features);
  const m = await model.trainLogistic(train, norm);
  const w = Object.fromEntries(features.map((f, i) => [f, m.weights[i]]));
  assert.ok(w["core.score"] > 0.5, `score weight ${w["core.score"]}`);
  assert.ok(w["core.critical"] < -0.5, `critical weight ${w["core.critical"]}`);
  assert.ok(Math.abs(w["metric.irrelevant"]) < Math.abs(w["core.score"]) / 4, "an irrelevant feature stays small");
  const p = validation.map((e) => model.predictLogistic(m, e.x).probability);
  const metrics = model.binaryMetrics(p, validation.map((e) => e.y), 0.5);
  assert.ok(metrics.auc > 0.9, `AUC ${metrics.auc}`);
  assert.ok(metrics.logLoss < metrics.baselineLogLoss, "beats the base rate");
  assert.ok(m.converged, "converged before the epoch limit");
});

test("training is reproducible: same data, same weights", async () => {
  const data = synthetic(300, 11);
  const f = model.selectFeatures(data);
  const a = await model.trainLogistic(data, model.fitNormalizer(data, f));
  const b = await model.trainLogistic([...data].reverse().reverse(), model.fitNormalizer(data, f));
  assert.deepEqual(a.weights, b.weights);
  assert.equal(a.bias, b.bias);
});

test("missing values are filled with the training mean (z = 0), not zero", () => {
  const data = [
    { id: "a", group: "a", x: { s: 10, t: 1 }, y: 1, weight: 1 },
    { id: "b", group: "b", x: { s: 30, t: 2 }, y: 0, weight: 1 },
  ];
  const norm = model.fitNormalizer(data, ["s", "t"]);
  assert.deepEqual(model.standardize(norm, { t: 1 }), [0, -1]);
  assert.deepEqual(model.standardize(norm, { s: 20, t: Number.NaN }), [0, 0]);
  assert.deepEqual(model.standardize(norm, { s: 1e9, t: 1.5 }), [5, 0], "clipped to ±5");
});

test("class balancing gives both outcomes the same total weight, scaled by label trust", () => {
  const w = model.balancedWeights([1, 1, 1, 0], [1, 1, 1, 1]);
  const pos = w[0] + w[1] + w[2];
  assert.ok(Math.abs(pos - w[3]) < 1e-9);
  const trust = model.balancedWeights([1, 0, 0], [1, 0.5, 1]);
  assert.ok(Math.abs(trust[1] / trust[2] - 0.5) < 1e-9);
});

test("stronger L2 regularisation gives smaller weights", async () => {
  const data = synthetic(300, 3);
  const f = model.selectFeatures(data);
  const norm = model.fitNormalizer(data, f);
  const loose = await model.trainLogistic(data, norm, { ...model.DEFAULT_HYPER, lambda: 0.001 });
  const tight = await model.trainLogistic(data, norm, { ...model.DEFAULT_HYPER, lambda: 0.5 });
  const size = (m) => Math.hypot(...m.weights);
  assert.ok(size(tight) < size(loose) / 2);
});

test("the split keeps every site on one side, is stable as data grows, and is about 20%", () => {
  const data = synthetic(500).flatMap((e) => [e, { ...e, id: `${e.id}b` }]); // two scans per site
  const { train, validation } = model.splitByGroup(data, 0.2, "s");
  const trainSites = new Set(train.map((e) => e.group));
  assert.ok(validation.every((e) => !trainSites.has(e.group)), "no site on both sides");
  const share = validation.length / data.length;
  assert.ok(share > 0.14 && share < 0.26, `share ${share}`);
  const more = model.splitByGroup([...data, ...synthetic(100, 99).map((e) => ({ ...e, group: `new${e.group}` }))], 0.2, "s");
  const before = new Set(validation.map((e) => e.group));
  assert.ok(more.validation.filter((e) => !e.group.startsWith("new")).every((e) => before.has(e.group)), "existing sites do not move");
});

test("metrics: AUC, calibration and log loss behave at the edges", () => {
  assert.equal(model.auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(model.auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(model.auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  assert.ok(Number.isNaN(model.auc([0.3, 0.4], [1, 1])));
  const m = model.binaryMetrics([0, 1, 1, 0], [0, 1, 0, 1], 0.5);
  assert.ok(Number.isFinite(m.logLoss) && m.logLoss > 10, "a confident wrong answer is costly but finite");
  const calibrated = model.binaryMetrics([0.25, 0.25, 0.25, 0.25], [1, 0, 0, 0], 0.25);
  assert.ok(calibrated.ece < 1e-9);
  assert.equal(calibrated.precision, 0, "no positive predictions → precision 0, not NaN");
});

test("softmax regression learns three separable reasons", async () => {
  const r = rng(5);
  const rows = Array.from({ length: 300 }, (_, i) => {
    const label = ["a", "b", "c"][i % 3];
    const x = { u: (label === "a" ? 3 : 0) + r(), v: (label === "b" ? 3 : 0) + r() };
    return { x, label, weight: 1 };
  });
  const norm = model.fitNormalizer(rows.map((e, i) => ({ id: String(i), group: "", x: e.x, y: 0, weight: 1 })), ["u", "v"]);
  const m = await model.trainSoftmax(rows, ["a", "b", "c"], norm);
  const metrics = model.multiclassMetrics(rows.map((e) => model.predictSoftmax(m, e.x)), rows.map((e) => e.label), ["a", "b", "c"], { a: 1 / 3, b: 1 / 3, c: 1 / 3 });
  assert.ok(metrics.accuracy > 0.95, `accuracy ${metrics.accuracy}`);
  assert.ok(metrics.logLoss < metrics.baselineLogLoss);
});

/* ── features and the cold-start estimate ───────────────────────── */

const OUTCOME = {
  score: 71,
  passedCount: 20,
  warningCount: 4,
  criticalCount: 2,
  pagesFetched: 6,
  categories: [
    { id: "content", score: 60 },
    { id: "privacy", score: 90 },
  ],
  findings: [
    { id: "cnt-depth", status: "warn" },
    { id: "pvl-privacy", status: "pass" },
    { id: "hidden_text", status: "fail", analyzer: {} },
  ],
  metrics: { partial: false, totalWords: 4200, duplicateShare: 0.1, riskLevel: "low", aiReliable: true },
  featureVector: { "hidden_text.status": 0, "hidden_text.hidden_links": 3 },
};

test("a scan becomes a numbers-only vector with stable, namespaced names", () => {
  const v = buildFeatureVector(OUTCOME);
  assert.equal(v["core.score"], 71);
  assert.equal(v["core.critical"], 2);
  assert.equal(v["cat.content"], 60);
  assert.equal(v["check.cnt_depth"], 0.5);
  assert.equal(v["check.pvl_privacy"], 1);
  assert.equal(v["check.hidden_text"], undefined, "analyzer lines come from the analyzer vector");
  assert.equal(v["az.hidden_text.status"], 0);
  assert.equal(v["az.hidden_text.hidden_links"], 3);
  assert.equal(v["metric.totalwords"], 4200);
  assert.equal(v["metric.aireliable"], 1);
  assert.ok(Object.values(v).every((x) => typeof x === "number" && Number.isFinite(x)));
  assert.equal(FEATURE_SCHEMA, "fs-1");
});

test("sanitising drops non-numbers, bad names and absurd values", () => {
  const v = sanitizeVector({ "ok.name": 1, "Bad Name": 2, "x.nan": Number.NaN, "x.str": "5", "x.big": 1e30, "evil.<script>": 1 });
  assert.deepEqual(v, { "ok.name": 1, "x.big": 1e9 });
});

test("the cold-start estimate is the published rule, labelled rule-based, never a probability", () => {
  const e = ruleBasedEstimate({ "core.score": 80, "core.critical": 1, "cat.content": 50, "cat.privacy": 95 });
  assert.equal(e.kind, "rule");
  assert.equal(e.label, "Estimated (rule-based)");
  assert.equal(e.index, Math.round(0.8 * 80 + 20 * (1 - 1 / 5)));
  assert.equal(e.weakest[0].feature, "cat.content");
  assert.match(e.limitations, /not a trained prediction and not a probability/);
  assert.equal(ruleBasedEstimate({}).index, 20, "an empty scan gets only the no-failures term");
});

test("label trust rules: young/corrected labels unused, contradictions halved, heavy labellers scaled", () => {
  const t = NOW;
  const rows = [
    { id: "a", userId: "u1", domain: "x.test", label: "approved", labelStatus: "accepted", labeledAt: t },
    { id: "b", userId: "u2", domain: "x.test", label: "rejected", labelStatus: "accepted", labeledAt: t + 5 * DAY },
    { id: "c", userId: "u3", domain: "y.test", label: "approved", labelStatus: "deferred", labeledAt: t },
    { id: "d", userId: "u4", domain: "z.test", label: "rejected", labelStatus: "accepted", labeledAt: t - 60 * DAY },
    { id: "e", userId: "u5", domain: "z.test", label: "approved", labelStatus: "accepted", labeledAt: t },
    ...Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, userId: "heavy", domain: `h${i}.test`, label: "approved", labelStatus: "accepted", labeledAt: t + i * 60_000 })),
  ];
  const w = Object.fromEntries(labelWeights(rows).map((x) => [x.id, x]));
  assert.equal(w.a.weight, 0.5);
  assert.equal(w.b.weight, 0.5);
  assert.match(w.a.notes[0], /opposite outcome/);
  assert.equal(w.c.weight, 0);
  assert.equal(w.d.weight, 1, "opposite answers 60 days apart are a re-application, not a contradiction");
  assert.equal(w.h0.weight, 0.8);
  assert.match(w.h0.notes[0], /25 labels/);
});

/* ── database ───────────────────────────────────────────────────── */

test("migration V12 applies to a version-11 database without touching existing rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of MIGRATIONS.slice(0, 11)) db.exec(sql);
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES ('u', 'U', 'u@x.test', 'h', 1, 1)").run();
  db.exec(MIGRATIONS[11]);
  assert.ok(MIGRATIONS.length >= 12);
  for (const table of ["scan_features", "feedback_requests", "ml_feedback", "model_versions", "ml_events"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  assert.equal(db.prepare("SELECT email FROM users").get().email, "u@x.test");
  const insert = (status, label) =>
    db.prepare(
      `INSERT INTO scan_features (id, report_id, user_id, domain, plan_id, feature_schema, feature_count, vector_json, label, label_status, created_at)
       VALUES (?, ?, 'u', 'x.test', 'free', 'fs-1', 0, '{}', ?, ?, 1)`,
    ).run(`s${Math.random()}`, `r${Math.random()}`, label, status);
  assert.throws(() => insert("accepted", "maybe"), "label is constrained");
  assert.throws(() => insert("bogus", null), "label status is constrained");
  db.prepare(`INSERT INTO scan_features (id, report_id, user_id, domain, plan_id, feature_schema, feature_count, vector_json, created_at) VALUES ('s1', 'r1', 'u', 'x', 'free', 'fs-1', 0, '{}', 1)`).run();
  assert.throws(() => db.prepare(`INSERT INTO scan_features (id, report_id, user_id, domain, plan_id, feature_schema, feature_count, vector_json, created_at) VALUES ('s2', 'r1', 'u', 'x', 'free', 'fs-1', 0, '{}', 1)`).run(), "one row per report");
  db.prepare("DELETE FROM users WHERE id = 'u'").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scan_features").get().n, 0, "deleting the account deletes its training rows");
  db.close();
});

getDb(); // the real database, migrated to the latest version
let userSeq = 0;
function makeUser(createdAt = NOW - 30 * DAY) {
  userSeq += 1;
  const id = `usr_t${userSeq}`;
  run("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'x', ?, ?)", [id, `Tester ${userSeq}`, `t${userSeq}@example.test`, createdAt, createdAt]);
  return id;
}

test("a completed scan is stored once, demo scans never, and a 14-day prompt opens", () => {
  const user = makeUser();
  const first = collectScanFeatures({ reportId: "rep_a1", userId: user, domain: "alpha.test", planId: "pro", demo: false, outcome: OUTCOME, now: NOW });
  assert.equal(first.stored, true);
  assert.equal(first.estimate.kind, "rule");
  assert.equal(collectScanFeatures({ reportId: "rep_a1", userId: user, domain: "alpha.test", planId: "pro", demo: false, outcome: OUTCOME, now: NOW }).stored, false, "a retry stores nothing new");
  assert.equal(collectScanFeatures({ reportId: "rep_demo", userId: user, domain: "alpha.test", planId: "pro", demo: true, outcome: OUTCOME, now: NOW }).stored, false);
  const row = store.scanFeaturesForReport("rep_a1");
  assert.equal(row.model_version, "rule-based");
  assert.ok(!/alpha|example|@/.test(row.vector_json), "no domain, email or text in the vector");
  const prompts = many("SELECT * FROM feedback_requests WHERE user_id = ?", [user]);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].due_at, NOW + 14 * DAY);
  assert.equal(feedback.dueFeedbackRequests(user, NOW + 13 * DAY).length, 0, "not shown early");
  assert.equal(feedback.dueFeedbackRequests(user, NOW + 14 * DAY).length, 1);

  collectScanFeatures({ reportId: "rep_a2", userId: user, domain: "alpha.test", planId: "pro", demo: false, outcome: OUTCOME, now: NOW + 3 * DAY });
  const moved = many("SELECT * FROM feedback_requests WHERE user_id = ?", [user]);
  assert.equal(moved.length, 1, "still one prompt per site");
  assert.equal(moved[0].report_id, "rep_a2", "moved to the newer scan");
  assert.equal(moved[0].due_at, NOW + 14 * DAY, "without pushing the date back");
});

function promptFor(user, domain, reportId, at = NOW) {
  collectScanFeatures({ reportId, userId: user, domain, planId: "pro", demo: false, outcome: OUTCOME, now: at });
  return one("SELECT * FROM feedback_requests WHERE user_id = ? AND domain = ? AND state = 'open'", [user, domain]);
}

test("feedback: validation, ownership, duplicates, one correction within 7 days, every submission recorded", () => {
  const user = makeUser();
  const other = makeUser();
  const req1 = promptFor(user, "beta.test", "rep_b1");
  const at = NOW + 15 * DAY;
  const submit = (o) => feedback.submitFeedback({ userId: user, accountCreatedAt: NOW - 30 * DAY, requestId: req1.id, now: at, ...o });

  assert.equal(submit({ outcome: "maybe" }).code, "VALIDATION_ERROR");
  assert.equal(submit({ outcome: "rejected", reason: "free text with an email a@b.c" }).code, "VALIDATION_ERROR");
  assert.equal(feedback.submitFeedback({ userId: other, accountCreatedAt: 0, requestId: req1.id, outcome: "approved", now: at }).code, "NOT_FOUND", "another account cannot answer");

  assert.equal(submit({ outcome: "rejected", reason: "navigation" }).status, "accepted");
  let row = store.scanFeaturesForReport("rep_b1");
  assert.deepEqual([row.label, row.rejection_reason, row.label_status, row.label_source], ["rejected", "navigation", "accepted", "user_feedback"]);
  assert.equal(submit({ outcome: "rejected", reason: "navigation" }).status, "duplicate");
  assert.equal(submit({ outcome: "approved", now: at + DAY }).status, "accepted", "one correction within 7 days");
  assert.equal(store.scanFeaturesForReport("rep_b1").label, "approved");
  const again = submit({ outcome: "rejected", now: at + 2 * DAY });
  assert.equal(again.ok, false);
  assert.match(again.message, /already corrected once/);
  assert.equal(store.scanFeaturesForReport("rep_b1").label, "approved", "the second correction changed nothing");

  const log = many("SELECT status FROM ml_feedback WHERE user_id = ? ORDER BY created_at, rowid", [user]).map((r) => r.status);
  assert.deepEqual(log, ["superseded", "duplicate", "accepted", "refused"], "valid submissions are all recorded (validation errors never reach the store)");
  assert.equal(feedback.dueFeedbackRequests(user, at + 30 * DAY).length, 0, "an answered site is not asked again");
});

test("a correction after 7 days is refused, with the reason recorded", () => {
  const user = makeUser();
  const r = promptFor(user, "gamma.test", "rep_g1");
  const at = NOW + 15 * DAY;
  feedback.submitFeedback({ userId: user, accountCreatedAt: 0, requestId: r.id, outcome: "approved", now: at });
  const late = feedback.submitFeedback({ userId: user, accountCreatedAt: 0, requestId: r.id, outcome: "rejected", now: at + 8 * DAY });
  assert.equal(late.ok, false);
  assert.equal(one("SELECT status_reason FROM ml_feedback WHERE user_id = ? AND status = 'refused'", [user]).status_reason, "Correction more than 7 days after the first answer.");
});

test("answers from accounts under 3 days old are deferred, then accepted automatically", () => {
  const created = NOW + 14 * DAY;
  const user = makeUser(created);
  const r = promptFor(user, "delta.test", "rep_d1");
  const result = feedback.submitFeedback({ userId: user, accountCreatedAt: created, requestId: r.id, outcome: "approved", now: created + DAY });
  assert.equal(result.status, "deferred");
  assert.equal(store.scanFeaturesForReport("rep_d1").label_status, "deferred");
  assert.equal(feedback.promoteDeferred(created + 2 * DAY), 0, "still too young");
  assert.ok(feedback.promoteDeferred(created + 3 * DAY + 1) >= 1);
  assert.equal(store.scanFeaturesForReport("rep_d1").label_status, "accepted");
  assert.equal(one("SELECT status FROM ml_feedback WHERE scan_features_id = ?", [store.scanFeaturesForReport("rep_d1").id]).status, "accepted");
});

test("'not applied yet' asks again in 14 days, three times at most", () => {
  const user = makeUser();
  const r = promptFor(user, "eps.test", "rep_e1");
  let at = NOW + 14 * DAY;
  for (let i = 1; i <= 3; i += 1) {
    const res = feedback.submitFeedback({ userId: user, accountCreatedAt: 0, requestId: r.id, outcome: "not_applied", now: at });
    assert.equal(res.status, "recorded");
    at += 14 * DAY;
  }
  assert.equal(one("SELECT state FROM feedback_requests WHERE id = ?", [r.id]).state, "closed");
  assert.equal(store.scanFeaturesForReport("rep_e1").label, null, "no label from 'not applied'");
  collectScanFeatures({ reportId: "rep_e2", userId: user, domain: "eps.test", planId: "pro", demo: false, outcome: OUTCOME, now: at });
  assert.equal(many("SELECT * FROM feedback_requests WHERE user_id = ? AND state = 'open'", [user]).length, 0, "not re-asked after the maximum");
});

test("approved sites are never asked again; a scan after a rejection opens a new prompt (re-application)", () => {
  const user = makeUser();
  const a = promptFor(user, "zeta.test", "rep_z1");
  feedback.submitFeedback({ userId: user, accountCreatedAt: 0, requestId: a.id, outcome: "approved", now: NOW + 15 * DAY });
  assert.equal(feedback.ensureFeedbackRequest({ userId: user, domain: "zeta.test", reportId: "rep_z2", scannedAt: NOW + 20 * DAY, now: NOW + 20 * DAY }), "not_needed");
  const b = promptFor(user, "eta.test", "rep_h1");
  feedback.submitFeedback({ userId: user, accountCreatedAt: 0, requestId: b.id, outcome: "rejected", now: NOW + 15 * DAY });
  assert.equal(feedback.ensureFeedbackRequest({ userId: user, domain: "eta.test", reportId: "rep_h2", scannedAt: NOW + 30 * DAY, now: NOW + 30 * DAY }), "created");
});

test("feedback emails: sent once through the mailer, retried when delivery is not configured, skipped for blocked accounts", async () => {
  const user = makeUser();
  promptFor(user, "theta.test", "rep_t1");
  const at = NOW + 14 * DAY;
  const original = console.log;
  const printed = [];
  console.log = (...args) => printed.push(args.join(" "));
  let tally;
  try {
    tally = await processFeedbackEmails(at);
  } finally {
    console.log = original;
  }
  assert.ok(tally.sent >= 1);
  const row = one("SELECT * FROM feedback_requests WHERE user_id = ?", [user]);
  assert.equal(row.email_status, "sent");
  const again = await processFeedbackEmails(at + DAY);
  assert.ok(!again.sent || !many("SELECT id FROM feedback_requests WHERE user_id = ? AND email_attempts > 1", [user]).length, "never sent twice");

  const blocked = makeUser();
  promptFor(blocked, "iota.test", "rep_i1");
  run("UPDATE users SET status = 'blocked' WHERE id = ?", [blocked]);
  process.env.EMAIL_PROVIDER = "nonsense";
  const broken = makeUser();
  promptFor(broken, "kappa.test", "rep_k1");
  try {
    await processFeedbackEmails(at);
  } finally {
    process.env.EMAIL_PROVIDER = "console";
  }
  assert.equal(one("SELECT email_status FROM feedback_requests WHERE user_id = ?", [blocked]).email_status, "skipped");
  const retry = one("SELECT email_status, email_error, email_next_at FROM feedback_requests WHERE user_id = ?", [broken]);
  assert.equal(retry.email_status, "retry");
  assert.match(retry.email_error, /isn't configured/);
  assert.ok(retry.email_next_at > at);
});

/* ── training, promotion, rollback ──────────────────────────────── */

/** Puts labelled synthetic examples into scan_features, spread over 30 accounts. */
function seedLabels(examples, prefix) {
  const users = Array.from({ length: 30 }, () => makeUser(NOW - 90 * DAY));
  examples.forEach((e, i) => {
    const reportId = `${prefix}_${e.id}`;
    store.insertScanFeatures({ reportId, userId: users[i % users.length], domain: `${prefix}-${e.group}`, planId: "pro", analysisMode: "live", featureSchema: FEATURE_SCHEMA, vector: e.x, modelVersion: "rule-based", estimate: null, now: NOW - 40 * DAY });
    run(
      "UPDATE scan_features SET label = ?, rejection_reason = ?, label_status = 'accepted', label_source = 'test', labeled_at = ? WHERE report_id = ?",
      [e.y ? "approved" : "rejected", e.y ? null : e.reason, NOW - 30 * DAY + i * 3_600_000, reportId],
    );
  });
}

function clearLabels() {
  run("UPDATE scan_features SET label_status = 'excluded' WHERE label IS NOT NULL");
}

test("below 200 usable labels training is skipped, recorded, and estimates stay rule-based", async () => {
  const result = await runTraining({ trigger: "test", now: NOW });
  assert.equal(result.outcome, "skipped");
  assert.match(result.message, /needs at least 200/);
  assert.equal(one("SELECT event FROM ml_events ORDER BY created_at DESC, rowid DESC LIMIT 1").event, "skipped");
  assert.equal(one("SELECT COUNT(*) AS n FROM model_versions").n, 0);
  assert.equal(estimateApproval({ "core.score": 90 }).kind, "rule");
});

let firstModel;
test("with enough labels a model trains, passes validation, is promoted and used for estimates", async () => {
  seedLabels(synthetic(420, 21), "a");
  const result = await runTraining({ trigger: "test", now: NOW });
  assert.equal(result.outcome, "promoted", result.message);
  firstModel = result;
  const active = store.toModelVersion(store.activeModelRow());
  assert.equal(active.version, result.version);
  assert.ok(active.metrics.validation.auc > 0.85);
  assert.ok(active.metrics.criteria.every((c) => c.ok));
  assert.ok(active.metrics.dataset.validationGroups > 0 && active.validationCount >= 40);
  assert.equal(active.model.normalizer.features.includes("metric.irrelevant"), true);
  assert.ok(active.reasonModel === null || active.metrics.reasons.used, "a reason model is stored only when it passed");

  resetModelCache();
  const good = estimateApproval({ "core.score": 92, "core.critical": 0 });
  const bad = estimateApproval({ "core.score": 35, "core.critical": 5 });
  assert.equal(good.kind, "model");
  assert.equal(good.label, "Estimated (trained model)");
  assert.equal(good.version, result.version);
  assert.ok(good.probability > 0.8 && bad.probability < 0.2, `${good.probability} / ${bad.probability}`);
  assert.match(good.limitations, /does not reproduce Google's internal review/);
  assert.ok(good.factors.some((f) => f.feature === "core.score" && f.effect > 0));
});

test("the nightly run skips an unchanged dataset instead of minting an identical version", async () => {
  const nightly = await runTraining({ trigger: "nightly", now: NOW + DAY });
  assert.equal(nightly.outcome, "skipped");
  assert.match(nightly.message, /No new or changed labels/);
});

test("a worse candidate is stored but not promoted, and the active model stays", async () => {
  clearLabels();
  seedLabels(synthetic(420, 22, { randomLabels: true }), "r");
  const result = await runTraining({ trigger: "test", now: NOW + 2 * DAY });
  assert.equal(result.outcome, "not_promoted", result.message);
  assert.match(result.message, /AUC|base rate|regression/);
  assert.equal(store.activeModelRow().version, firstModel.version);
  assert.equal(one("SELECT status FROM model_versions WHERE id = ?", [result.id]).status, "rejected");
  assert.equal(rollbackTo(result.id, "admin@test").ok, false, "a version that failed its checks cannot be activated");
});

test("a better model replaces the active one, which stays available for rollback", async () => {
  clearLabels();
  seedLabels(synthetic(480, 23, { noise: 0.3 }), "b");
  const result = await runTraining({ trigger: "test", now: NOW + 3 * DAY });
  assert.equal(result.outcome, "promoted", result.message);
  assert.equal(one("SELECT status FROM model_versions WHERE id = ?", [firstModel.id]).status, "retired");
  const back = rollbackTo(firstModel.id, "admin@test", NOW + 4 * DAY);
  assert.equal(back.ok, true);
  assert.equal(store.activeModelRow().id, firstModel.id);
  resetModelCache();
  assert.equal(estimateApproval({ "core.score": 80 }).version, firstModel.version);
  assert.equal(one("SELECT event FROM ml_events WHERE event = 'rolled_back'").event, "rolled_back");
  assert.equal(one("SELECT COUNT(*) AS n FROM model_versions WHERE status = 'active'").n, 1, "exactly one active model");
});

test("only one training run at a time; a failed run is recorded, not silent", async () => {
  assert.equal(store.acquireTrainingLock("someone", 60_000), true);
  const busy = await runTraining({ trigger: "test" });
  assert.equal(busy.outcome, "busy");
  store.releaseTrainingLock("someone");

  getDb().exec("ALTER TABLE model_versions RENAME TO model_versions_away");
  const original = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await runTraining({ trigger: "manual", now: NOW + 5 * DAY });
  } finally {
    console.error = original;
    getDb().exec("ALTER TABLE model_versions_away RENAME TO model_versions");
  }
  assert.equal(failed.outcome, "failed");
  assert.match(one("SELECT detail FROM ml_events WHERE event = 'failed' ORDER BY rowid DESC LIMIT 1").detail, /Training failed: .*model_versions/);
  assert.equal(store.trainingRunning(), null, "the lock is released after a failure");
});

test("nightly schedule: once a day in the training hour, with a catch-up after 36 hours", () => {
  const at = (h) => Date.UTC(2026, 9, 14, h, 10);
  assert.equal(trainingDue(at(21), null), true);
  assert.equal(trainingDue(at(21), at(21) - 21 * 3_600_000), true);
  assert.equal(trainingDue(at(21), at(21) - 2 * 3_600_000), false);
  assert.equal(trainingDue(at(9), at(9) - 30 * 3_600_000), false);
  assert.equal(trainingDue(at(9), at(9) - 37 * 3_600_000), true);
});
