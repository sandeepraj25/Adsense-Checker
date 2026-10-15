// Phase 7: the cases the other suites did not already cover.
//
//     node scripts/phase7-test.mjs
//
// Real lib/ modules, compiled; the fixture websites on port 8080 with
// *-fixture.com resolved to 127.0.0.1 in this process only. No build, no
// server, no internet.
//
//   1  smart insights with missing and malformed data, and a failing one
//   2  a feature switched off in admin stops running; on again, it runs for
//      new subscriptions; current subscribers keep it unless revoked;
//      CPU-heavy signals are not computed for a plan without them
//   5  a corrupted stored model falls back to the rule-based estimate;
//      logistic regression converges and its loss falls
//   6  oversized and stalled responses, a redirect to a private address,
//      malformed HTML, and no internal detail in a failed scan's message

import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";
import "./fixtures/dns-hook.mjs";
import { startSites } from "./fixtures/sites.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
Object.assign(process.env, { NODE_ENV: "development", ANALYSIS_DEADLINE_MS: "15000" });
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ANALYSIS_DEMO_FALLBACK", "ALLOW_PRIVATE_ANALYSIS_HOSTS"]) delete process.env[name];

const lib = compileLib(projectRoot, "aec-phase7-");
process.env.DATA_DIR = path.join(lib.workDir, "data");
process.on("exit", () => lib.cleanup());
const L = lib.require;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    console.log(`  ✗ ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const quietly = async (fn) => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
};

const insights = L("./analysis/insights/index.js");
const { INSIGHT_REGISTRY } = L("./analysis/insights/keys.js");
const { ruleBasedEstimate } = L("./ml/rules.js");
const { buildFeatureVector } = L("./ml/features.js");
const predict = L("./ml/predict.js");
const mlModel = L("./ml/model.js");
const mlStore = L("./ml/store.js");
const engine = L("./analysis/engine.js");
const signals = L("./analysis/signals.js");
const fetcher = L("./analysis/fetcher.js");
const types = L("./analysis/types.js");
const service = L("./audit-service.js");
const accounts = L("./db/accounts.js");
const billing = L("./db/billing.js");
const audits = L("./db/audits.js");
const catalogue = L("./plan-catalogue.js");
const entitlement = L("./entitlement.js");
const { run } = L("./db/index.js");
const { PLANS } = L("./plans.js");

const sites = await startSites(8080);
const BAD = "http://badblog-fixture.com:8080/";
const admin = { id: "admin-p7", email: "admin@example.test" };
let seq = 0;
const newUser = (plan) => {
  seq += 1;
  const u = accounts.createUser({ name: `P7 ${seq}`, email: `p7-${Date.now()}-${seq}@example.test`, passwordHash: "x" });
  const sub = plan ? billing.createSubscription({ userId: u.id, plan: catalogue.requirePlan(plan), paymentStatus: plan === "free" ? "free" : "paid" }) : null;
  return { user: accounts.findUserById(u.id), sub };
};

console.log("Phase 7 — remaining coverage");

/* ── 1. smart insights: missing data, malformed data, a failure ───── */

function contextFor(outcome, extra = {}) {
  // The vector is built by the scan pipeline from the engine's own outcome;
  // here the insights are handed junk directly.
  const vector = buildFeatureVector(extra.vectorFrom ?? outcome);
  return {
    userId: extra.userId ?? "nobody", domain: "insight-fixture.com", reportId: "rep_p7", websiteId: "site_p7", planId: "pro",
    outcome, vector, estimate: ruleBasedEstimate(vector), features: new Set(INSIGHT_REGISTRY.map((e) => e.key)), demo: false, now: Date.now(),
  };
}
const bareOutcome = {
  score: 0, verdict: "not_ready", categories: [], findings: [], passedCount: 0, warningCount: 0, criticalCount: 0, pagesFetched: 0,
  pageUrls: [], features: [], locked: [], pages: [], metrics: {}, checksRun: 0, featureVector: {},
};

await check("1.1 every smart insight answers a scan with no findings, no metrics and no history", async () => {
  const { findings } = await insights.runInsights(insights.INSIGHTS, contextFor(bareOutcome));
  assert.equal(findings.length, 6);
  for (const line of findings) {
    assert.notEqual(line.status, "error", `${line.id}: ${line.detail}`);
    assert.equal(line.status === "fail", false, "an insight never fails");
    assert.ok(line.detail.length > 0);
  }
});

await check("1.2 malformed scan data (wrong types, NaN, junk lines) never throws and never fails", async () => {
  const junk = {
    ...bareOutcome, score: Number.NaN,
    categories: [{ id: "content", score: "high" }, null],
    findings: [{ id: 7, status: "weird", priority: null, label: undefined }, { id: "cnt-depth", status: "fail", priority: "high", category: "content", label: "Page depth", detail: "", fix: "" }],
    metrics: { totalWords: -5, sitemapUrls: "many", niche: 12 },
  };
  const { value } = await quietly(() => insights.runInsights(insights.INSIGHTS, contextFor(junk, { vectorFrom: bareOutcome })));
  assert.equal(value.findings.length, 6);
  for (const line of value.findings) assert.ok(["pass", "warn", "error"].includes(line.status), `${line.id}: ${line.status}`);
});

await check("1.3 an insight that throws is an 'error' line with a safe message; the others stand", async () => {
  const boom = { ...insights.INSIGHTS[0], run: () => { throw new Error("SELECT * FROM secrets /srv/app"); } };
  const { value, lines } = await quietly(() => insights.runInsights([boom, ...insights.INSIGHTS.slice(1)], contextFor(bareOutcome)));
  const first = value.findings[0];
  assert.equal(first.status, "error");
  assert.ok(!JSON.stringify(first).includes("/srv/app"), "no internal detail in the line");
  assert.ok(lines.some((l) => /secrets/.test(l)), "logged for the operator");
  assert.ok(value.findings.slice(1).every((l) => l.status !== "error"));
});

/* ── 2. entitlement: off stops execution, on restores it ─────────── */

const FEATURE = "hidden_text";
const ranOn = async (features) => (await engine.runAnalysis(BAD, features, { pageLimit: 5 })).findings.some((f) => f.id === FEATURE);

await check("2.1 a Pro scan runs the analyzer; switched off in admin, new Pro subscriptions don't have it and it is not run", async () => {
  const { sub: before } = newUser("pro");
  assert.equal(await ranOn(entitlement.effectiveFeatures(before)), true, "runs while on");
  const off = catalogue.updatePlan("pro", { features: catalogue.requirePlan("pro").features.filter((f) => f !== FEATURE) }, admin);
  assert.equal(off.ok, true, off.error);
  const { sub: after } = newUser("pro");
  assert.equal(entitlement.hasFeature(after, FEATURE), false);
  const outcome = await engine.runAnalysis(BAD, entitlement.effectiveFeatures(after), { pageLimit: 5 });
  assert.equal(outcome.findings.some((f) => f.id === FEATURE), false, "not executed");
  assert.equal(outcome.locked.includes(FEATURE), true, "shown as locked in the report");
  // Existing semantics: someone who already paid keeps it this period…
  assert.equal(entitlement.hasFeature(billing.findSubscription(before.id), FEATURE), true, "current subscriber keeps it");
  // …unless the admin also removes it from current subscribers.
  assert.equal(billing.revokeFeaturesFromActive("pro", [FEATURE]) >= 1, true);
  assert.equal(entitlement.hasFeature(billing.findSubscription(before.id), FEATURE), false, "revoked on request");
  assert.equal(await ranOn(entitlement.effectiveFeatures(billing.findSubscription(before.id))), false);
});

await check("2.2 switched back on, new subscriptions get it and it runs again", async () => {
  const on = catalogue.updatePlan("pro", { features: [...catalogue.requirePlan("pro").features, FEATURE] }, admin);
  assert.equal(on.ok, true, on.error);
  const { sub } = newUser("pro");
  assert.equal(entitlement.hasFeature(sub, FEATURE), true);
  assert.equal(await ranOn(entitlement.effectiveFeatures(sub)), true);
});

await check("2.3 a Free scan never runs a premium analyzer (nothing Pro-only appears in its findings)", async () => {
  const free = new Set(PLANS.free.features);
  const outcome = await engine.runAnalysis(BAD, PLANS.free.features, { pageLimit: 1 });
  for (const f of outcome.findings) assert.ok(!f.feature || free.has(f.feature), `${f.id} (${f.feature}) ran on Free`);
});

await check("2.4 CPU-heavy signals are gated before they run: Free computes no AI or duplicate analysis", async () => {
  const calls = { ai: 0, dup: 0 };
  const realAi = signals.estimateAiLikelihood;
  const realDup = signals.findDuplicates;
  signals.estimateAiLikelihood = (...a) => { calls.ai += 1; return realAi(...a); };
  signals.findDuplicates = (...a) => { calls.dup += 1; return realDup(...a); };
  try {
    await engine.runAnalysis(BAD, PLANS.free.features, { pageLimit: 1 });
    assert.deepEqual(calls, { ai: 0, dup: 0 }, "Free");
    await engine.runAnalysis(BAD, PLANS.basic.features, { pageLimit: 5 });
    assert.ok(calls.ai > 0 && calls.dup > 0, `Basic ran them: ${JSON.stringify(calls)}`);
  } finally {
    signals.estimateAiLikelihood = realAi;
    signals.findDuplicates = realDup;
  }
});

/* ── 5. ML: loading a damaged model; convergence ─────────────────── */

await check("5.1 a stored model that cannot be read falls back to the rule-based estimate, logged, never thrown", async () => {
  const id = mlStore.insertModelVersion({
    version: "p7-broken", algorithm: "logistic", featureSchema: "v1", model: { kind: "logistic", normalizer: { features: ["core.score"], means: [0], stds: [1] }, weights: [1], bias: 0 },
    reasonModel: null, datasetSnapshot: "p7", decision: "test", metrics: { validation: { n: 1, auc: 1, logLoss: 0, ece: 0 }, criteria: [], dataset: {}, reasons: { used: false } },
    trainCount: 1, validationCount: 1, status: "candidate", now: Date.now(),
  });
  mlStore.activateVersion(id);
  run("UPDATE model_versions SET model_json = '{not json' WHERE version = 'p7-broken'");
  predict.resetModelCache();
  const { value, lines } = await quietly(() => predict.estimateApproval({ "core.score": 70 }));
  assert.equal(value.kind, "rule");
  assert.ok(lines.some((l) => /could not be read|failed/.test(l)), "logged");
  run("UPDATE model_versions SET status = 'retired' WHERE version = 'p7-broken'");
  predict.resetModelCache();
});

await check("5.2 logistic regression converges on separable data, and its loss falls as it trains", async () => {
  const examples = Array.from({ length: 200 }, (_, i) => {
    const score = (i * 37) % 100;
    return { id: String(i), group: `g${i}`, x: { "core.score": score, "core.noise": (i * 13) % 7 }, y: score >= 50 ? 1 : 0, weight: 1 };
  });
  const features = mlModel.selectFeatures(examples);
  const normalizer = mlModel.fitNormalizer(examples, features);
  const full = await mlModel.trainLogistic(examples, normalizer);
  assert.equal(full.converged, true, `converged within ${full.epochs} epochs`);
  assert.ok(full.epochs < mlModel.DEFAULT_HYPER.maxEpochs);
  const short = await mlModel.trainLogistic(examples, normalizer, { ...mlModel.DEFAULT_HYPER, maxEpochs: 5 });
  assert.ok(full.trainLoss < short.trainLoss, `loss ${short.trainLoss} → ${full.trainLoss}`);
  const p = (s) => mlModel.predictLogistic(full, { "core.score": s, "core.noise": 3 }).probability;
  assert.ok(p(90) > 0.9 && p(10) < 0.1, `${p(90)} / ${p(10)}`);
});

/* ── 6. resilience: size, stalls, redirects, markup, error messages ── */

const nasty = createServer((req, res) => {
  if (req.url === "/huge") {
    res.writeHead(200, { "content-type": "text/html" });
    const chunk = "<p>" + "x".repeat(64 * 1024) + "</p>";
    let sent = 0;
    const pump = () => {
      while (sent < 400) { // 25 MB if nobody stops reading
        sent += 1;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end();
    };
    return pump();
  }
  if (req.url === "/stall") {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<html><body><p>first bytes");
    return; // and nothing more, ever
  }
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<<<html><head><title>Broken <b>title</head><body><div><p>unclosed <a href="/x">link <script>var s = '</p>
      ${"Words of a page whose markup never closes properly. ".repeat(60)}<table><tr><td>cell<div></span></i></em>\u0000 tail`);
  }
  if (req.url === "/to-metadata") {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => nasty.listen(8443, "127.0.0.1", r));

await check("6.1 an oversized response is cut at 2 MB and marked truncated", async () => {
  const r = await fetcher.fetchGuarded("http://nasty-fixture.com:8443/huge", { timeoutMs: 10_000 });
  assert.equal(r.truncated, true);
  assert.ok(r.body.length <= 2 * 1024 * 1024 && r.bytes <= 2 * 1024 * 1024, `${r.bytes} bytes kept`);
});

await check("6.2 a response that stalls is abandoned at its time limit", async () => {
  const started = Date.now();
  await assert.rejects(fetcher.fetchGuarded("http://nasty-fixture.com:8443/stall", { timeoutMs: 1_000 }));
  assert.ok(Date.now() - started < 4_000, `${Date.now() - started} ms`);
});

await check("6.3 a redirect to the cloud metadata address is refused, not followed", async () => {
  await assert.rejects(fetcher.fetchGuarded("http://nasty-fixture.com:8443/to-metadata", { timeoutMs: 3_000 }), (error) => {
    assert.ok(!/meta-data\/\S*:/.test(String(error.message)));
    return true;
  });
});

await check("6.4 malformed HTML scans to a complete report", async () => {
  const { value: outcome } = await quietly(() => engine.runAnalysis("http://nasty-fixture.com:8443/", PLANS.pro.features, { pageLimit: 3 }));
  assert.ok(outcome.score >= 0 && outcome.score <= 100);
  assert.ok(outcome.findings.length > 60);
  const errors = outcome.findings.filter((f) => f.status === "error");
  assert.ok(errors.length <= 2, `checks that errored on broken markup: ${errors.map((f) => f.id).join(", ")}`);
});

await check("6.5 a scan that fails inside is refunded and its message names no path, query or library", async () => {
  const { user, sub } = newUser("basic");
  const realPreflight = fetcher.preflight;
  const realRun = engine.runAnalysis;
  fetcher.preflight = async () => ({ ok: true });
  engine.runAnalysis = async () => { throw new TypeError("Cannot read properties of undefined (reading 'x') at /srv/app/lib/analysis/engine.js:812 SELECT * FROM users"); };
  try {
    const { value } = await quietly(() => service.startAudit(user, "leaky.com", { wait: true }));
    assert.equal(value.ok, false);
    assert.equal(value.code, "ANALYSIS_FAILED");
    const stored = audits.listReports(user.id)[0];
    for (const text of [value.message, stored.errorMessage]) {
      assert.ok(!/srv|engine\.js|SELECT|TypeError|undefined/.test(text), text);
    }
    assert.equal(billing.findSubscription(sub.id).scansUsed, 0, "refunded");
  } finally {
    fetcher.preflight = realPreflight;
    engine.runAnalysis = realRun;
  }
});

await check("6.6 a site that cannot be reached is a clear failure, refunded, and says so in plain words", async () => {
  const { user, sub } = newUser("basic");
  const realPreflight = fetcher.preflight;
  const realRun = engine.runAnalysis;
  fetcher.preflight = async () => ({ ok: true });
  engine.runAnalysis = async () => { throw new types.AnalysisFailure("The site did not respond in time.", true); };
  try {
    const { value } = await quietly(() => service.startAudit(user, "down-forever.com", { wait: true }));
    assert.deepEqual([value.ok, value.code, value.message], [false, "SITE_UNREACHABLE", "The site did not respond in time."]);
    assert.equal(billing.findSubscription(sub.id).scansUsed, 0);
  } finally {
    fetcher.preflight = realPreflight;
    engine.runAnalysis = realRun;
  }
});

nasty.close();
sites.close?.();
console.log(`\nphase 7 coverage: passed (${passed} checks)`);
process.exit(0);
