// Phase 2c: the six smart insights (features 48–53) and weekly rescans —
// registry and gating, each insight's pass/warn cases and wording, the
// niche classifier, scan comparison, the schedule store and job (every
// failure path), change emails, the V13 upgrade and the scan pipeline.
// Real compiled lib/ and a throwaway database; no network.
//
//     node --test --test-concurrency=1 scripts/insights-test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_ENV = "test";
process.env.EMAIL_PROVIDER = "console";
process.env.ANALYSIS_DEMO_FALLBACK = "true"; // the pipeline test needs a scan without network
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD"]) delete process.env[name];

const lib = compileLib(projectRoot, "aec-insights-");
process.env.DATA_DIR = path.join(lib.workDir, "data");
process.on("exit", () => lib.cleanup());
const req = lib.require;

const insights = req("./analysis/insights/index.js");
const { INSIGHT_REGISTRY } = req("./analysis/insights/keys.js");
const { ANALYZERS, assertRegistry } = req("./analysis/analyzers/index.js");
const { ANALYZER_CATALOG } = req("./analysis/analyzers/catalog.js");
const { classifyNiche } = req("./analysis/niche.js");
const { diffScans } = req("./analysis/insights/history.js");
const { ruleBasedReasons } = req("./analysis/insights/rejection_reason_predictor.js");
const { ruleBasedEstimate } = req("./ml/rules.js");
const { buildFeatureVector } = req("./ml/features.js");
const mlStore = req("./ml/store.js");
const { resetModelCache } = req("./ml/predict.js");
const schedules = req("./schedules/store.js");
const scheduleJob = req("./schedules/job.js");
const auditService = req("./audit-service.js");
const { processRescanEmails } = req("./schedules/email.js");
const { getDb, run, one, many } = req("./db/index.js");
const { MIGRATIONS } = req("./db/schema.js");
const { createUser, findUserById } = req("./db/accounts.js");
const { createSubscription } = req("./db/billing.js");
const { requirePlan } = req("./plan-catalogue.js");
const audits = req("./db/audits.js");
const { CORE_FEATURE_KEYS, CHECKS } = { ...req("./plans.js"), ...req("./analysis/checks.js") };

const DAY = 86_400_000;
const NOW = Date.now();
getDb();

let seq = 0;
function makeUser(plan = "pro", createdAt = NOW - 60 * DAY) {
  seq += 1;
  const user = createUser({ name: `Tester ${seq}`, email: `ins${seq}@example.test`, passwordHash: "x" });
  run("UPDATE users SET created_at = ? WHERE id = ?", [createdAt, user.id]);
  if (plan) createSubscription({ userId: user.id, plan: requirePlan(plan), paymentStatus: plan === "free" ? "free" : "paid" });
  return findUserById(user.id);
}

/** A stored, complete report with these lines, as the scan pipeline would leave it. */
function storeReport(user, domain, { score = 60, lines = [], features = ["basic_page_check"], at = NOW, mode = "live" } = {}) {
  const site = audits.upsertWebsite(user.id, domain);
  const report = audits.createRunningReport({
    userId: user.id, websiteId: site.id, subscriptionId: null, url: `https://${domain}/`, domain, planId: "pro", planName: "Pro",
    engineVersion: "2.0.0", analysisMode: mode, features,
  });
  run("UPDATE reports SET started_at = ?, created_at = ? WHERE id = ?", [at, at, report.id]);
  audits.completeReport({
    reportId: report.id, score, verdict: "needs_improvement", categories: [], passedCount: 0, warningCount: 0, criticalCount: 0, pagesFetched: 6,
    issues: lines.map((l) => ({ checkId: l.id, categoryId: "content", label: l.label ?? l.id, status: l.status, priority: l.priority ?? "medium", detail: "x" })),
    features, locked: [], pages: [], metrics: {}, checksRun: lines.length,
  });
  return { report: audits.findReport(report.id), site };
}

function outcomeWith({ score = 70, critical = 1, findings = [], metrics = {}, features = ["basic_page_check"], vector = {} } = {}) {
  return {
    score, verdict: "needs_improvement", categories: [{ id: "content", score: 55 }, { id: "privacy", score: 80 }], findings,
    passedCount: 10, warningCount: 2, criticalCount: critical, pagesFetched: 6, pageUrls: [], features, locked: [], pages: [],
    metrics: { totalWords: 3000, averageWords: 600, ...metrics }, checksRun: findings.length, featureVector: vector,
  };
}

function ctxFor(user, domain, outcome, extra = {}) {
  const vector = buildFeatureVector(outcome);
  return {
    userId: user.id, domain, reportId: extra.reportId ?? "rep_current", websiteId: extra.websiteId ?? audits.upsertWebsite(user.id, domain).id,
    planId: "pro", outcome, vector, estimate: extra.estimate ?? ruleBasedEstimate(vector),
    features: new Set(extra.features ?? INSIGHT_REGISTRY.map((e) => e.key)), demo: Boolean(extra.demo), now: extra.now ?? NOW,
  };
}

const lineOf = async (key, ctx) => {
  const def = insights.INSIGHTS.find((d) => d.key === key);
  const { findings } = await insights.runInsights([def], ctx);
  return findings[0];
};

/* ── registry and runner ────────────────────────────────────────── */

test("the six smart features are registered, Pro by default, with code behind each", () => {
  const smart = ANALYZER_CATALOG.filter((e) => e.category === "smart");
  assert.deepEqual(smart.map((e) => e.key), ["approval_probability", "rejection_reason_predictor", "similar_sites_comparison", "rescan_diff", "readiness_timeline", "scheduled_rescan"]);
  assert.ok(smart.every((e) => e.defaultPlan === "pro" && e.scope === "site"));
  assert.deepEqual(assertRegistry(ANALYZERS, undefined, [...CORE_FEATURE_KEYS, ...CHECKS.map((c) => c.id)]), []);
  assert.deepEqual(insights.assertInsights(), []);
  assert.equal(ANALYZER_CATALOG.length, 53);
  const pro = requirePlan("pro").features;
  for (const e of smart) assert.ok(pro.includes(e.key), `${e.key} on Pro`);
  assert.ok(!requirePlan("basic").features.includes("approval_probability"), "not on Basic");
});

test("the runner gates by feature, isolates errors, never scores and never fails", async () => {
  const user = makeUser();
  const calls = [];
  const defs = [
    { key: "approval_probability", name: "A", category: "smart", scope: "site", defaultPlan: "pro", run: () => (calls.push("a"), { status: "fail", findings: [], recommendation: "do x" }) },
    { key: "rescan_diff", name: "B", category: "smart", scope: "site", defaultPlan: "pro", run: () => { calls.push("b"); throw new Error("boom"); } },
    { key: "readiness_timeline", name: "C", category: "smart", scope: "site", defaultPlan: "pro", run: () => (calls.push("c"), { status: "pass", findings: [], recommendation: "" }) },
    { key: "similar_sites_comparison", name: "D", category: "smart", scope: "site", defaultPlan: "pro", timeoutMs: 50, run: () => new Promise(() => {}) },
  ];
  const original = console.error;
  console.error = () => {};
  try {
    const ctx = ctxFor(user, "gate.test", outcomeWith(), { features: ["approval_probability", "rescan_diff", "similar_sites_comparison"] });
    const { findings, ran } = await insights.runInsights(defs, ctx);
    assert.deepEqual(calls, ["a", "b"], "C is not in the plan, so it is never called");
    assert.deepEqual(ran, ["approval_probability", "rescan_diff", "similar_sites_comparison"]);
    assert.equal(findings[0].status, "warn", "a 'fail' from an insight is shown as a warning");
    assert.equal(findings[1].status, "error");
    assert.match(findings[1].detail, /says nothing about your site/);
    assert.equal(findings[2].status, "error", "a hung insight times out");
    assert.ok(findings.every((f) => f.weight === 0 && f.analyzer.category === "smart"));
  } finally {
    console.error = original;
  }
});

/* ── 48 approval estimate ───────────────────────────────────────── */

test("48 approval estimate: rule-based until a model exists, clearly labelled, never called a probability", async () => {
  const user = makeUser();
  const line = await lineOf("approval_probability", ctxFor(user, "est.test", outcomeWith({ score: 50, critical: 3 })));
  assert.equal(line.status, "warn");
  assert.match(line.detail, /^Estimated \(rule-based\): readiness index \d+\/100/);
  assert.match(line.detail, /not a probability/);
  assert.equal(line.analyzer.score, Math.round(0.8 * 50 + 20 * (1 - 3 / 5)));
  assert.equal(line.analyzer.confidence, "low");
  assert.ok(line.analyzer.items.some((i) => /0\.8 × readiness score/.test(i.evidence ?? "")));
  const good = await lineOf("approval_probability", ctxFor(user, "est.test", outcomeWith({ score: 95, critical: 0 })));
  assert.equal(good.status, "pass");
});

test("48 approval estimate with a trained model names the version, validation and limits", async () => {
  const user = makeUser();
  const estimate = {
    kind: "model", label: "Estimated (trained model)", probability: 0.42, version: "v20261014.0100-abc", algorithm: "logistic_regression_gd", trainedAt: NOW,
    validation: { n: 120, auc: 0.81, logLoss: 0.52, ece: 0.05 },
    factors: [{ feature: "core.critical", label: "High-priority failures", value: 4, effect: -0.9 }, { feature: "core.score", label: "Overall readiness score", value: 60, effect: 0.3 }],
    reasons: null, limitations: "This estimate is learned from outcomes … does not reproduce Google's internal review, does not guarantee approval …",
  };
  const line = await lineOf("approval_probability", ctxFor(user, "m.test", outcomeWith(), { estimate }));
  assert.match(line.detail, /Estimated approval probability 42% \(trained model v20261014\.0100-abc\)/);
  assert.ok(line.analyzer.items.some((i) => /AUC 0\.81/.test(i.evidence ?? "")));
  assert.ok(line.analyzer.items.some((i) => /does not reproduce Google's internal review/.test(i.message)));
  assert.match(line.fix, /high-priority failures/);
});

/* ── 49 rejection reasons ───────────────────────────────────────── */

test("49 rejection reasons (rule-based): mapped from failing lines, weighted by priority, labelled", async () => {
  const user = makeUser();
  const findings = [
    { id: "hidden_text", label: "Hidden text and links", status: "fail", priority: "high", analyzer: { category: "policy" } },
    { id: "cnt-thin", label: "Thin pages", status: "warn", priority: "medium" },
    { id: "nav-menu", label: "Menu", status: "pass", priority: "low" },
    { id: "approval_probability", label: "x", status: "warn", priority: "low", analyzer: { category: "smart" } },
  ];
  const ranked = ruleBasedReasons(findings);
  assert.equal(ranked[0].reason, "policy_violation");
  assert.equal(ranked.length, 2, "passes and smart lines don't count");
  assert.ok(Math.abs(ranked[0].share - 5 / 6) < 1e-9);
  const line = await lineOf("rejection_reason_predictor", ctxFor(user, "r.test", outcomeWith({ findings })));
  assert.equal(line.status, "warn");
  assert.match(line.detail, /^Estimated \(rule-based\).*Policy violation/);
  assert.ok(line.analyzer.items.some((i) => /not probabilities and not Google's decision/.test(i.message)));
  const clean = await lineOf("rejection_reason_predictor", ctxFor(user, "r.test", outcomeWith({ findings: [findings[2]] })));
  assert.equal(clean.status, "pass");
});

test("49 rejection reasons use the trained reason model when one is active", async () => {
  const user = makeUser();
  const normalizer = { features: ["core.critical"], mean: [2], std: [1], coverage: [1] };
  const hyper = { lambda: 0.01, learningRate: 0.2, maxEpochs: 10, tolerance: 1e-7 };
  const id = mlStore.insertModelVersion({
    version: "v-test-reasons", algorithm: "logistic_regression_gd+softmax_gd", featureSchema: "fs-1",
    model: { kind: "logistic", normalizer, weights: [-1], bias: 0, hyper, epochs: 1, converged: true, trainLoss: 0.5 },
    reasonModel: { kind: "softmax", classes: ["policy_violation", "low_value_content", "other"], normalizer, weights: [[2], [-2], [0]], bias: [0, 0, 0], hyper, epochs: 1, converged: true, trainLoss: 1 },
    datasetSnapshot: "x", trainCount: 300, validationCount: 60,
    metrics: { validation: { n: 60, auc: 0.8, logLoss: 0.5, ece: 0.05 }, train: {}, previous: null, criteria: [], reasons: { n: 40, accuracy: 0.6, macroF1: 0.5, logLoss: 0.9, baselineLogLoss: 1.1, classes: ["policy_violation", "low_value_content", "other"], used: true, note: "ok" }, dataset: {}, features: 1 },
    decision: "test", status: "candidate", now: NOW,
  });
  mlStore.activateVersion(id);
  resetModelCache();
  try {
    const line = await lineOf("rejection_reason_predictor", ctxFor(user, "rm.test", outcomeWith({ critical: 5 })));
    assert.match(line.detail, /policy violation .*\d+%, trained model v-test-reasons/i);
    assert.ok(line.analyzer.items.some((i) => /not Google's decision/.test(i.message)));
  } finally {
    run("UPDATE model_versions SET status = 'retired' WHERE id = ?", [id]);
    resetModelCache();
  }
});

/* ── 50 similar sites ───────────────────────────────────────────── */

test("niche classifier: clear subjects are named, mixed or thin text stays general", () => {
  const food = classifyNiche([{ title: "Easy paneer curry recipe", headings: ["Ingredients", "How to cook"], text: "This recipe takes 30 minutes. Add the spices, masala and a cup of flour to the sauce in the kitchen. Bake or cook the chicken curry. ".repeat(20) }]);
  assert.equal(food.niche, "food");
  const general = classifyNiche([{ title: "Hello", headings: [], text: "We write about many different things here. ".repeat(40) }]);
  assert.equal(general.niche, "general");
  assert.equal(classifyNiche([]).niche, "general");
});

test("50 similar sites: no comparison until 10 sites from 3 accounts; then aggregates only, never another site's name", async () => {
  const me = makeUser();
  const outcome = outcomeWith({ score: 72, critical: 1, metrics: { niche: "food", sitemapUrls: 18 } });
  const vector = buildFeatureVector(outcome);
  const insert = (user, domain, score, label = null) => {
    mlStore.insertScanFeatures({ reportId: `rep_${domain}`, userId: user.id, domain, planId: "pro", analysisMode: "live", featureSchema: "fs-1",
      vector: { ...vector, "core.score": score, "core.critical": score > 70 ? 0 : 2 }, modelVersion: "rule-based", estimate: null, niche: "food", now: NOW - DAY });
    if (label) run("UPDATE scan_features SET label = ?, label_status = 'accepted' WHERE report_id = ?", [label, `rep_${domain}`]);
  };
  const owners = [makeUser(), makeUser(), makeUser()];
  for (let i = 0; i < 6; i += 1) insert(owners[i % 3], `kitchen${i}.example`, 50 + i * 5);
  let line = await lineOf("similar_sites_comparison", ctxFor(me, "mine.example", outcome));
  assert.equal(line.status, "warn");
  assert.match(line.detail, /Not enough comparable food & recipes sites yet \(6 of 10/);

  for (let i = 6; i < 14; i += 1) insert(owners[i % 3], `kitchen${i}.example`, 50 + i * 3, i % 2 ? "approved" : null);
  insert(me, "mine.example", 10); // the site itself never counts
  line = await lineOf("similar_sites_comparison", ctxFor(me, "mine.example", outcome));
  assert.match(line.detail, /Compared with 14 food & recipes sites/);
  const text = JSON.stringify(line);
  assert.ok(!/kitchen\d/.test(text), "no other site is named");
  assert.ok(line.analyzer.items.some((i) => /Readiness score: yours 72, niche median/.test(i.message)));
  assert.ok(line.analyzer.items.some((i) => /too few to show their figures separately/.test(i.message)), "4 reported approvals is too few");
  const general = await lineOf("similar_sites_comparison", ctxFor(me, "mine.example", outcomeWith({ metrics: { niche: "general" } })));
  assert.match(general.detail, /isn't compared/);
});

/* ── 51 rescan diff ─────────────────────────────────────────────── */

test("51 changes since last scan: fixed, new, worse, still open, score change and plan changes", async () => {
  const user = makeUser();
  const first = await lineOf("rescan_diff", ctxFor(user, "diff.example", outcomeWith()));
  assert.match(first.detail, /First complete scan of this site/);

  const { site } = storeReport(user, "diff.example", {
    score: 55, at: NOW - 7 * DAY, features: ["basic_page_check", "real_word_count"],
    lines: [
      { id: "cnt-thin", status: "fail" }, { id: "nav-menu", status: "pass" }, { id: "seo-title", status: "warn" },
      { id: "tec-https", status: "warn" }, { id: "real_word_count", status: "warn" }, { id: "approval_probability", status: "warn" },
    ],
  });
  storeReport(user, "diff.example", { score: 99, at: NOW - 30 * DAY, mode: "demo", lines: [] }); // demo reports are never compared
  const outcome = outcomeWith({
    score: 63, features: ["basic_page_check", "hidden_text"],
    findings: [
      { id: "cnt-thin", label: "Thin pages", status: "pass", priority: "high" },
      { id: "nav-menu", label: "Menu", status: "fail", priority: "high" },
      { id: "seo-title", label: "Titles", status: "fail", priority: "medium" },
      { id: "tec-https", label: "HTTPS", status: "warn", priority: "medium" },
      { id: "hidden_text", label: "Hidden text", status: "pass", priority: "low" },
    ],
  });
  const line = await lineOf("rescan_diff", ctxFor(user, "diff.example", outcome, { websiteId: site.id }));
  assert.equal(line.status, "warn");
  assert.match(line.detail, /score 55 → 63 \(\+8\); 1 fixed, 1 new, 1 worse, 1 still open/);
  const msgs = line.analyzer.items.map((i) => i.message);
  for (const m of ["New problem: Menu", "Got worse: Titles", "Fixed: Thin pages", "Still open: HTTPS"]) assert.ok(msgs.includes(m), m);
  assert.ok(msgs.some((m) => /Checks added since then \(plan change\): Hidden text/.test(m)));
  assert.ok(msgs.some((m) => /Checks no longer included: Real word count/.test(m)));
});

test("scan comparison: a change of 5+ points or any line change is meaningful; otherwise not", () => {
  const base = { id: "p", ref: "RPT-X", at: 0, features: [] };
  const same = diffScans({ previous: { ...base, score: 60, lines: [{ id: "a", label: "A", status: "pass", priority: "low" }] }, current: { score: 63, features: [], lines: [{ id: "a", label: "A", status: "pass", priority: "low" }] } });
  assert.equal(same.meaningful, false);
  const moved = diffScans({ previous: { ...base, score: 60, lines: [] }, current: { score: 66, features: [], lines: [] } });
  assert.equal(moved.meaningful, true);
});

/* ── 52 readiness timeline ──────────────────────────────────────── */

test("52 readiness timeline: effort from open problems, pace from sitemap growth, assumptions shown, no dates", async () => {
  const user = makeUser();
  const findings = [
    { id: "cnt-thin", label: "Thin pages", status: "fail", priority: "high" },
    { id: "nav-menu", label: "Menu", status: "fail", priority: "medium" },
    { id: "seo-title", label: "Titles", status: "warn", priority: "low" },
    { id: "approval_probability", label: "x", status: "warn", priority: "high" },
  ];
  // Two weeks ago the sitemap had 5 URLs; now 9 → 2 a week; 16 to go → 8 weeks.
  mlStore.insertScanFeatures({ reportId: "rep_tl_old", userId: user.id, domain: "time.example", planId: "pro", analysisMode: "live", featureSchema: "fs-1", vector: { "metric.sitemapurls": 5 }, modelVersion: null, estimate: null, now: NOW - 14 * DAY });
  const line = await lineOf("readiness_timeline", ctxFor(user, "time.example", outcomeWith({ findings, metrics: { sitemapUrls: 9 } })));
  assert.equal(line.status, "warn");
  const msgs = line.analyzer.items.map((i) => `${i.message} ${i.evidence ?? ""}`).join("\n");
  assert.match(msgs, /3 open problems ≈ 4\.8 working days/, "smart lines are not counted");
  assert.match(msgs, /9 URLs in the sitemap vs a working target of 25; 16 to go at 2 a week ≈ 8 weeks/);
  assert.match(msgs, /sitemap grew from 5 to 9 URLs/);
  assert.match(msgs, /not a Google rule/);
  assert.match(line.detail, /5 weeks to 12 weeks of work.*Not an approval date/);
  assert.match(line.fix, /Content volume is the longer path/);
  assert.equal(line.analyzer.confidence, "medium");

  const unknown = await lineOf("readiness_timeline", ctxFor(user, "fresh.example", outcomeWith({ findings: [], metrics: { sitemapUrls: 21 } })));
  assert.ok(unknown.analyzer.items.some((i) => /2 posts a week is assumed/.test(i.evidence ?? "")));
  assert.equal(unknown.analyzer.confidence, "low");
  const ready = await lineOf("readiness_timeline", ctxFor(user, "ready.example", outcomeWith({ findings: [{ id: "seo-title", label: "T", status: "warn", priority: "low" }], metrics: { sitemapUrls: 40 } })));
  assert.equal(ready.status, "pass");
  assert.match(ready.detail, /not a promise of approval/);
});

/* ── 53 weekly rescans ──────────────────────────────────────────── */

test("53 schedules: one per site, on/off, next run a week after the last scan, Pro only", () => {
  const pro = makeUser("pro");
  const free = makeUser("free");
  assert.equal(schedules.canSchedule(pro.id).ok, true);
  const no = schedules.canSchedule(free.id);
  assert.equal(no.ok, false);
  assert.match(no.reason, /doesn't include weekly rescans/);

  storeReport(pro, "sched.example", { at: NOW - 2 * DAY });
  const on = schedules.setSchedule({ userId: pro.id, domain: "sched.example", enabled: true, now: NOW });
  assert.equal(on.enabled, true);
  assert.equal(on.nextRunAt, NOW + 7 * DAY);
  schedules.setSchedule({ userId: pro.id, domain: "sched.example", enabled: true, now: NOW + DAY });
  assert.equal(schedules.getSchedule(pro.id, "sched.example").nextRunAt, NOW + 7 * DAY, "turning on twice keeps the cadence");
  assert.equal(one("SELECT COUNT(*) AS n FROM scan_schedules WHERE user_id = ?", [pro.id]).n, 1);
  const off = schedules.setSchedule({ userId: pro.id, domain: "sched.example", enabled: false, now: NOW });
  assert.equal(off.enabled, false);
  assert.equal(off.stateReason, "Turned off by you.");
  assert.throws(() => run("INSERT INTO scan_schedules (id, user_id, domain, next_run_at, created_at, updated_at) VALUES ('dup', ?, 'sched.example', 0, 0, 0)", [pro.id]), "UNIQUE per account and site");
});

test("53 the report line shows on, paused and off", async () => {
  const user = makeUser();
  let line = await lineOf("scheduled_rescan", ctxFor(user, "line.example", outcomeWith()));
  assert.equal(line.status, "warn");
  assert.match(line.detail, /off for this site/);
  schedules.setSchedule({ userId: user.id, domain: "line.example", enabled: true, now: NOW });
  line = await lineOf("scheduled_rescan", ctxFor(user, "line.example", outcomeWith()));
  assert.equal(line.status, "pass");
  assert.match(line.detail, /Weekly rescans are on — next scan around/);
  run("UPDATE scan_schedules SET state = 'paused', state_reason = 'Paused: plan expired.' WHERE user_id = ?", [user.id]);
  line = await lineOf("scheduled_rescan", ctxFor(user, "line.example", outcomeWith()));
  assert.match(line.detail, /paused\. Paused: plan expired\./);
});

/** Runs the job with startAudit replaced, so each failure path can be produced on demand. */
async function withAudit(fake, fn) {
  const real = auditService.startAudit;
  auditService.startAudit = fake;
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    auditService.startAudit = real;
    console.log = log;
  }
}

function dueSchedule(user, domain) {
  run("UPDATE scan_schedules SET enabled = 0"); // each job test sees only its own schedule
  storeReport(user, domain, { at: NOW - 8 * DAY });
  schedules.setSchedule({ userId: user.id, domain, enabled: true, now: NOW - 8 * DAY });
  run("UPDATE scan_schedules SET next_run_at = ? WHERE user_id = ? AND domain = ?", [NOW - 60_000, user.id, domain]);
  return schedules.getSchedule(user.id, domain);
}

test("53 job: a due rescan runs through the normal scan path, emails changes once, and moves to next week", async () => {
  const user = makeUser();
  const sched = dueSchedule(user, "weekly.example");
  run("DELETE FROM report_issues WHERE report_id IN (SELECT id FROM reports WHERE user_id = ?)", [user.id]);
  const prevId = one("SELECT id FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", [user.id]).id;
  run("INSERT INTO report_issues (id, report_id, check_id, category_id, label, status, priority, detail, sort_order) VALUES ('i1', ?, 'nav-menu', 'navigation', 'Menu', 'pass', 'high', 'x', 0)", [prevId]);
  const calls = [];
  await withAudit(async (u, domain) => {
    calls.push(domain);
    const { report } = storeReport(u, domain, { score: 40, lines: [{ id: "nav-menu", label: "Menu", status: "fail", priority: "high" }] });
    return { ok: true, report, demo: false };
  }, () => scheduleJob.runScheduledRescans(NOW));
  assert.deepEqual(calls, ["weekly.example"]);
  const after = schedules.findScheduleRow(sched.id);
  assert.equal(after.last_outcome, "complete");
  assert.ok(after.next_run_at > NOW && after.next_run_at <= NOW + 7 * DAY, "next weekly slot");
  assert.equal(after.locked_until, null);
  const runRow = one("SELECT * FROM schedule_runs WHERE schedule_id = ?", [sched.id]);
  assert.equal(runRow.outcome, "complete");
  assert.match(runRow.detail, /1 new or worse.*Change email queued/);
  assert.equal(runRow.email_status, "sent", "sent in the same pass");
  const again = await withAudit(async () => assert.fail("not due"), () => scheduleJob.runScheduledRescans(NOW + 60_000));
  assert.equal(again.tally.complete, undefined, "not run twice");
  assert.equal((await processRescanEmails(NOW + DAY)).sent, undefined, "the email is not sent twice");
});

test("53 job: no change → no email; expired plan → paused; allowance used → paused until reset; blocked → off", async () => {
  const quiet = makeUser();
  const qs = dueSchedule(quiet, "quiet.example");
  await withAudit(async (u, d) => ({ ok: true, report: storeReport(u, d, { score: 60 }).report, demo: false }), () => scheduleJob.runScheduledRescans(NOW));
  assert.equal(one("SELECT email_status FROM schedule_runs WHERE schedule_id = ?", [qs.id]).email_status, "none");

  const lapsed = makeUser();
  const ls = dueSchedule(lapsed, "lapsed.example");
  run("UPDATE subscriptions SET expires_at = ?, status = 'expired' WHERE user_id = ?", [NOW - DAY, lapsed.id]);
  await withAudit(async () => assert.fail("must not scan"), () => scheduleJob.runScheduledRescans(NOW));
  let row = schedules.findScheduleRow(ls.id);
  assert.equal(row.state, "paused");
  assert.match(row.state_reason, /^Paused: /);
  assert.equal(row.next_run_at, NOW + DAY, "checked again tomorrow");
  run("UPDATE scan_schedules SET paused_since = ?, next_run_at = ? WHERE id = ?", [NOW - 31 * DAY, NOW - 1, ls.id]);
  await withAudit(async () => assert.fail("must not scan"), () => scheduleJob.runScheduledRescans(NOW));
  row = schedules.findScheduleRow(ls.id);
  assert.equal(row.enabled, 0);
  assert.match(row.state_reason, /after 30 days paused/);

  const capped = makeUser();
  const cs = dueSchedule(capped, "capped.example");
  await withAudit(async () => ({ ok: false, code: "LIMIT_REACHED", message: "Monthly scan limit reached." }), () => scheduleJob.runScheduledRescans(NOW));
  row = schedules.findScheduleRow(cs.id);
  assert.equal(row.state, "paused");
  assert.match(row.state_reason, /allowance is used up/);
  assert.ok(row.next_run_at > NOW + DAY);

  const blocked = makeUser();
  const bs = dueSchedule(blocked, "blocked.example");
  run("UPDATE users SET status = 'blocked' WHERE id = ?", [blocked.id]);
  await withAudit(async () => assert.fail("must not scan"), () => scheduleJob.runScheduledRescans(NOW));
  assert.equal(schedules.findScheduleRow(bs.id).enabled, 0);
});

test("53 job: failed scans retry after 1h and 6h, then wait a week; three failed weeks turn it off", async () => {
  const user = makeUser();
  const s = dueSchedule(user, "down.example");
  const fail = async () => ({ ok: false, code: "SITE_UNREACHABLE", message: "We could not reach down.example." });
  const step = async (at) => {
    run("UPDATE scan_schedules SET next_run_at = ?, locked_until = NULL WHERE id = ?", [at - 1, s.id]);
    await withAudit(fail, () => scheduleJob.runScheduledRescans(at));
    return schedules.findScheduleRow(s.id);
  };
  let row = await step(NOW);
  assert.equal(row.attempt, 1);
  assert.equal(row.next_run_at > NOW + 3_000_000 && row.next_run_at < NOW + 4_000_000, true, "about an hour");
  row = await step(NOW + 2 * 3_600_000);
  assert.equal(row.attempt, 2);
  row = await step(NOW + 9 * 3_600_000);
  assert.equal(row.attempt, 0);
  assert.equal(row.failed_weeks, 1);
  assert.match(row.state_reason, /This week's scan failed/);
  for (let week = 2; week <= 3; week += 1) for (let i = 0; i < 3; i += 1) row = await step(NOW + week * 7 * DAY + i * 10 * 3_600_000);
  assert.equal(row.enabled, 0);
  assert.match(row.state_reason, /failed 3 weeks in a row/);
  assert.ok(many("SELECT outcome FROM schedule_runs WHERE schedule_id = ?", [s.id]).every((r) => ["failed", "disabled"].includes(r.outcome)), "every attempt is logged");
});

test("53 job: a scan already running for the site is not overlapped; a crash never leaves a schedule locked", async () => {
  const user = makeUser();
  const s = dueSchedule(user, "busy.example");
  const site = audits.upsertWebsite(user.id, "busy.example");
  audits.createRunningReport({ userId: user.id, websiteId: site.id, subscriptionId: null, url: "https://busy.example/", domain: "busy.example", planId: "pro", planName: "Pro", engineVersion: "2.0.0", analysisMode: "live", features: [] });
  await withAudit(async () => assert.fail("must not overlap"), () => scheduleJob.runScheduledRescans(NOW));
  assert.equal(one("SELECT outcome FROM schedule_runs WHERE schedule_id = ? ORDER BY rowid DESC LIMIT 1", [s.id]).outcome, "skipped");
  run("UPDATE reports SET state = 'failed' WHERE user_id = ? AND state = 'running'", [user.id]);
  run("UPDATE scan_schedules SET next_run_at = ? WHERE id = ?", [NOW - 1, s.id]);
  const err = console.error;
  console.error = () => {};
  try {
    await withAudit(async () => { throw new Error("kaboom"); }, () => scheduleJob.runScheduledRescans(NOW));
  } finally {
    console.error = err;
  }
  const row = schedules.findScheduleRow(s.id);
  assert.equal(row.locked_until, null);
  assert.equal(row.last_outcome, "failed");
});

/* ── pipeline and database ──────────────────────────────────────── */

test("the scan pipeline adds the insight lines after scoring: score and counts are unchanged", async () => {
  const user = makeUser();
  const result = await auditService.startAudit(user, `aec-insights-nonexistent-${Date.now().toString(36)}.com`, { wait: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  const issues = audits.listIssues(result.report.id);
  assert.equal(result.demo, true, "a sample report, since the site cannot be reached");
  const smart = issues.filter((i) => i.analyzer?.category === "smart");
  assert.deepEqual(smart.map((i) => i.checkId), INSIGHT_REGISTRY.map((e) => e.key), "all six, in order, after the checks");
  const stored = audits.findReport(result.report.id);
  const scoredLines = issues.filter((i) => i.analyzer?.category !== "smart");
  assert.equal(stored.criticalCount, scoredLines.filter((i) => i.status === "fail").length, "insight lines are not counted");
  assert.equal(stored.checksRun, issues.length);
  assert.ok(smart.every((i) => i.status !== "fail"));
  assert.equal(one("SELECT COUNT(*) AS n FROM scan_features WHERE report_id = ?", [result.report.id]).n, 0, "sample reports are not training data");
});

test("migration V13 applies to a version-12 database and keeps rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of MIGRATIONS.slice(0, 12)) db.exec(sql);
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES ('u', 'U', 'u@x.test', 'h', 1, 1)").run();
  db.prepare("INSERT INTO scan_features (id, report_id, user_id, domain, plan_id, feature_schema, feature_count, vector_json, created_at) VALUES ('s', 'r', 'u', 'x', 'pro', 'fs-1', 0, '{}', 1)").run();
  db.exec(MIGRATIONS[12]);
  assert.ok(MIGRATIONS.length >= 13);
  assert.equal(db.prepare("SELECT niche FROM scan_features WHERE id = 's'").get().niche, null, "existing rows keep working");
  db.prepare("INSERT INTO scan_schedules (id, user_id, domain, next_run_at, created_at, updated_at) VALUES ('a', 'u', 'x.test', 1, 1, 1)").run();
  assert.throws(() => db.prepare("INSERT INTO scan_schedules (id, user_id, domain, next_run_at, created_at, updated_at) VALUES ('b', 'u', 'x.test', 1, 1, 1)").run());
  assert.throws(() => db.prepare("INSERT INTO schedule_runs (id, schedule_id, user_id, domain, outcome, detail, created_at) VALUES ('r', 'a', 'u', 'x', 'weird', 'd', 1)").run());
  db.prepare("DELETE FROM users WHERE id = 'u'").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scan_schedules").get().n, 0, "deleting the account removes its schedules");
  db.close();
});
