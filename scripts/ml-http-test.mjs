// Phase 3 over HTTP, against the production build: the admin
// "Prediction model" page and its buttons, the dashboard feedback card and
// its API, the scheduler endpoint and its email, and who may use each.
//
//     npm run test:ml-http        (builds first)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";
import { startMailSink } from "./lib/mail-sink.mjs";
import { isolatedServerEnv } from "./lib/server-env.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = { AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345", CREDENTIALS_SECRET: randomBytes(48).toString("base64") };
Object.assign(process.env, SECRETS, { NODE_ENV: "development", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key", EMAIL_FROM: "Checker <hello@example.test>" });
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "PAYMENTS_MODE"]) delete process.env[name];

const lib = compileLib(projectRoot, "aec-mlhttp-");
const dataDir = path.join(lib.workDir, "data");
process.env.DATA_DIR = dataDir;
const L = lib.require;
const accounts = L("./db/accounts.js");
const { hashPasswordSync } = L("./auth/password.js");
const { run, one, many, getDb } = L("./db/index.js");
const store = L("./ml/store.js");

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

console.log("prediction model over HTTP");
getDb();
const DAY = 86_400_000;
const now = Date.now();
const password = "Str0ng-Password!";
const stamp = Date.now();
const admin = accounts.createUser({ name: "Admin", email: `ml-admin-${stamp}@example.test`, passwordHash: hashPasswordSync(password), role: "admin" });
const customer = accounts.createUser({ name: "Asha Verma", email: `ml-cust-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
const stranger = accounts.createUser({ name: "Other", email: `ml-other-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
for (const u of [admin, customer, stranger]) run("UPDATE users SET created_at = ? WHERE id = ?", [now - 60 * DAY, u.id]);

// A scan the customer ran 15 days ago, so its feedback prompt is due.
store.insertScanFeatures({ reportId: "rep_http_1", userId: customer.id, domain: "asha-recipes.test", planId: "pro", analysisMode: "live", featureSchema: "fs-1", vector: { "core.score": 70 }, modelVersion: "rule-based", estimate: null, now: now - 15 * DAY });
run(
  `INSERT INTO feedback_requests (id, user_id, domain, report_id, state, due_at, ask_count, email_status, created_at, updated_at)
   VALUES ('fbr_http_1', ?, 'asha-recipes.test', 'rep_http_1', 'open', ?, 1, 'waiting', ?, ?)`,
  [customer.id, now - DAY, now - 15 * DAY, now - 15 * DAY],
);

/** 420 labelled synthetic scans with a learnable rule, spread over 30 old accounts. */
function seedLabels() {
  let a = 42;
  const r = () => ((a = (a * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const owners = Array.from({ length: 30 }, (_, i) => accounts.createUser({ name: `L${i}`, email: `ml-l${i}-${stamp}@example.test`, passwordHash: "x" }).id);
  for (const id of owners) run("UPDATE users SET created_at = ? WHERE id = ?", [now - 90 * DAY, id]);
  for (let i = 0; i < 420; i += 1) {
    const score = Math.round(30 + r() * 65);
    const critical = Math.floor(r() * 6);
    const y = 0.12 * (score - 62) - 0.9 * (critical - 2.5) + (r() * 2 - 1) > 0;
    store.insertScanFeatures({ reportId: `rep_l${i}`, userId: owners[i % 30], domain: `site${i}.test`, planId: "pro", analysisMode: "live", featureSchema: "fs-1", vector: { "core.score": score, "core.critical": critical, "metric.noise": r() }, modelVersion: "rule-based", estimate: null, now: now - 40 * DAY });
    run("UPDATE scan_features SET label = ?, label_status = 'accepted', label_source = 'test', labeled_at = ? WHERE report_id = ?", [y ? "approved" : "rejected", now - 30 * DAY + i * 60_000, `rep_l${i}`]);
  }
}

const mail = await startMailSink();
const CRON_SECRET = randomBytes(32).toString("hex");
const port = 5400 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: projectRoot,
  env: isolatedServerEnv({ ...process.env, ...SECRETS, ...mail.env, NODE_ENV: "production", DATA_DIR: dataDir, CRON_SECRET, CHECKOUT_ALERTS_BACKGROUND: "off", ML_BACKGROUND: "off", NEXT_PUBLIC_APP_URL: base }),
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let ipn = 0;
function browser() {
  const jar = new Map();
  const ip = `198.51.100.${(ipn += 1)}`;
  return async (pathname, { method = "GET", body, headers = {} } = {}) => {
    const h = new Headers({ "x-forwarded-for": ip, ...headers });
    if (jar.size) h.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (method !== "GET" && !headers.origin && !("authorization" in headers)) h.set("origin", base);
    if (body !== undefined) h.set("content-type", "application/json");
    const res = await fetch(`${base}${pathname}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [k, ...v] = pair.split("=");
      if (/Max-Age=0/i.test(raw)) jar.delete(k);
      else jar.set(k, v.join("="));
    }
    const text = (await res.text()).replace(/<!-- -->/g, "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, json, text };
  };
}

try {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${base}/pricing`)).ok) break;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const staff = browser();
  const cust = browser();
  const other = browser();
  const anon = browser();
  assert.equal((await staff("/api/auth/login", { method: "POST", body: { email: admin.email, password } })).status, 200);
  assert.equal((await cust("/api/auth/login", { method: "POST", body: { email: customer.email, password } })).status, 200);
  assert.equal((await other("/api/auth/login", { method: "POST", body: { email: stranger.email, password } })).status, 200);

  await check("1 Admin → Prediction model shows the cold-start state and the 200-label threshold", async () => {
    const page = await staff("/admin/ml");
    assert.equal(page.status, 200);
    for (const text of ["Prediction model", "Rule-based estimates (cold start)", "0 / 200", "Retrain now", "No trained model yet"]) assert.ok(page.text.includes(text), text);
    assert.ok((await staff("/admin")).text.includes('href="/admin/ml"'), "linked from the admin navigation");
  });

  await check("2 customers get a 404 for the page and are refused by the admin APIs", async () => {
    assert.equal((await cust("/admin/ml")).status, 404);
    assert.equal((await cust("/api/admin/ml/train", { method: "POST" })).status, 403);
    assert.equal((await anon("/api/admin/ml/train", { method: "POST" })).status, 401);
    assert.equal((await cust("/api/admin/ml/versions/mdl_x/activate", { method: "POST" })).status, 403);
  });

  await check("3 'Retrain now' with too few labels reports the skip, logs it, and audits the admin action", async () => {
    const res = await staff("/api/admin/ml/train", { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, "skipped");
    assert.match(res.json.message, /needs at least 200/);
    const page = await staff("/admin/ml");
    assert.ok(page.text.includes("Skipped"));
    assert.ok(one("SELECT * FROM admin_logs WHERE action = 'ml.train'"), "audit log entry");
  });

  await check("4 the dashboard asks the customer about their site, and no one else", async () => {
    const dash = await cust("/dashboard");
    assert.ok(dash.text.includes("Did AdSense approve") && dash.text.includes("asha-recipes.test"));
    for (const label of ["Approved", "Rejected", "Not applied yet"]) assert.ok(dash.text.includes(label), label);
    assert.ok(!(await other("/dashboard")).text.includes("asha-recipes.test"));
  });

  await check("5 the answer API: login required, ownership enforced, reasons validated, answer recorded", async () => {
    assert.equal((await anon("/api/account/adsense-feedback", { method: "POST", body: { requestId: "fbr_http_1", outcome: "approved" } })).status, 401);
    assert.equal((await other("/api/account/adsense-feedback", { method: "POST", body: { requestId: "fbr_http_1", outcome: "approved" } })).status, 404);
    assert.equal((await cust("/api/account/adsense-feedback", { method: "POST", body: { requestId: "fbr_http_1", outcome: "rejected", reason: "my own words" } })).status, 400);
    const ok = await cust("/api/account/adsense-feedback", { method: "POST", body: { requestId: "fbr_http_1", outcome: "rejected", reason: "low_value_content" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, "accepted");
    const row = one("SELECT label, rejection_reason, label_status FROM scan_features WHERE report_id = 'rep_http_1'");
    assert.deepEqual({ ...row }, { label: "rejected", rejection_reason: "low_value_content", label_status: "accepted" });
    assert.ok(!(await cust("/dashboard")).text.includes("Did AdSense approve"), "not asked again");
    const page = await staff("/admin/ml");
    assert.ok(page.text.includes("asha-recipes.test") && page.text.includes("Low value content"), "visible in the admin feedback table");
  });

  await check("6 the scheduler endpoint needs CRON_SECRET, then sends due feedback emails through the mailer", async () => {
    run(
      `INSERT INTO feedback_requests (id, user_id, domain, report_id, state, due_at, ask_count, email_status, created_at, updated_at)
       VALUES ('fbr_http_2', ?, 'second-site.test', 'rep_http_2', 'open', ?, 1, 'waiting', ?, ?)`,
      [stranger.id, now - DAY, now - 15 * DAY, now - 15 * DAY],
    );
    assert.equal((await anon("/api/internal/jobs/ml", { method: "POST", body: {} })).status, 401);
    const res = await anon("/api/internal/jobs/ml", { method: "POST", body: {}, headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const msg = mail.messages.find((m) => m.to === stranger.email);
    assert.ok(msg, "email delivered");
    assert.equal(msg.subject, "Did AdSense approve second-site.test?");
    assert.ok(msg.text.includes(`${base}/dashboard#adsense-feedback`));
    assert.equal(one("SELECT email_status FROM feedback_requests WHERE id = 'fbr_http_2'").email_status, "sent");
    await anon("/api/internal/jobs/ml", { method: "POST", body: {}, headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(mail.messages.filter((m) => m.to === stranger.email).length, 1, "sent once");
  });

  let first;
  await check("7 with 420 labels, 'Retrain now' trains, validates and promotes a model; the page shows it", async () => {
    seedLabels();
    const res = await staff("/api/admin/ml/train", { method: "POST" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.json.outcome, "promoted", res.json.message);
    first = res.json.version;
    const page = await staff("/admin/ml");
    for (const text of [`Trained model ${first} is active`, "Strongest factors", "Overall readiness score", "High-priority failures", "AUC", "Calibration error", "Promoted"]) {
      assert.ok(page.text.includes(text), text);
    }
  });

  await check("8 a second model replaces it; the first can be restored, and only by an admin", async () => {
    run("UPDATE scan_features SET label = CASE label WHEN 'approved' THEN 'approved' ELSE 'rejected' END, labeled_at = labeled_at + 1 WHERE report_id LIKE 'rep_l%'");
    const res = await staff("/api/admin/ml/train", { method: "POST" });
    assert.equal(res.json.outcome, "promoted", res.json.message);
    const old = one("SELECT id, status FROM model_versions WHERE version = ?", [first]);
    assert.equal(old.status, "retired");
    assert.ok((await staff("/admin/ml")).text.includes("Restore"));
    assert.equal((await cust(`/api/admin/ml/versions/${old.id}/activate`, { method: "POST" })).status, 403);
    const back = await staff(`/api/admin/ml/versions/${old.id}/activate`, { method: "POST" });
    assert.equal(back.status, 200);
    assert.equal(one("SELECT version FROM model_versions WHERE status = 'active'").version, first);
    assert.equal((await staff(`/api/admin/ml/versions/${old.id}/activate`, { method: "POST" })).status, 409, "already active");
    assert.ok(many("SELECT action FROM admin_logs WHERE action = 'ml.rollback'").length === 1);
  });

  await check("9 nothing secret or internal reached the server log", () => {
    assert.ok(!serverLog.includes(CRON_SECRET));
    assert.ok(!/TypeError|ReferenceError|SqliteError/.test(serverLog), serverLog.slice(-500));
  });

  console.log(`prediction model over HTTP: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close?.();
  lib.cleanup();
}
process.exit(0);
