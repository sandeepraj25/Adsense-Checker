// Phase 2c over HTTP, against the production build: the weekly-rescan
// switch on the report page, its API (plan, ownership, login), the
// scheduler endpoint, and the smart-insight lines in a stored report.
//
//     npm run test:insights-http        (builds first)

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

const lib = compileLib(projectRoot, "aec-inshttp-");
const dataDir = path.join(lib.workDir, "data");
process.env.DATA_DIR = dataDir;
const L = lib.require;
const accounts = L("./db/accounts.js");
const { hashPasswordSync } = L("./auth/password.js");
const { run, one, many, getDb } = L("./db/index.js");
const audits = L("./db/audits.js");
const { createSubscription } = L("./db/billing.js");
const { requirePlan } = L("./plan-catalogue.js");

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

console.log("smart insights over HTTP");
getDb();
const DAY = 86_400_000;
const now = Date.now();
const password = "Str0ng-Password!";
const stamp = Date.now();
const pro = accounts.createUser({ name: "Pro Owner", email: `ins-pro-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
const free = accounts.createUser({ name: "Free Owner", email: `ins-free-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
createSubscription({ userId: pro.id, plan: requirePlan("pro"), paymentStatus: "paid" });
createSubscription({ userId: free.id, plan: requirePlan("free"), paymentStatus: "free" });

function storedReport(user, domain, lines) {
  const site = audits.upsertWebsite(user.id, domain);
  const report = audits.createRunningReport({ userId: user.id, websiteId: site.id, subscriptionId: null, url: `https://${domain}/`, domain, planId: "pro", planName: "Pro", engineVersion: "2.0.0", analysisMode: "live", features: ["basic_page_check"] });
  audits.completeReport({ reportId: report.id, score: 71, verdict: "needs_improvement", categories: [], passedCount: 1, warningCount: 1, criticalCount: 0, pagesFetched: 6,
    issues: lines, features: ["basic_page_check"], locked: [], pages: [], metrics: { niche: "food" }, checksRun: lines.length });
  return report.id;
}
const proReport = storedReport(pro, "pro-site.example", [
  { checkId: "nav-menu", categoryId: "navigation", label: "Menu", status: "pass", priority: "low", detail: "ok" },
  { checkId: "approval_probability", categoryId: "technical", label: "Approval estimate", status: "warn", priority: "low", detail: "Estimated (rule-based): readiness index 64/100 (moderate). This is not a probability of approval.", feature: "approval_probability", analyzer: { category: "smart", items: [] } },
]);
const freeReport = storedReport(free, "free-site.example", [{ checkId: "nav-menu", categoryId: "navigation", label: "Menu", status: "pass", priority: "low", detail: "ok" }]);

const mail = await startMailSink();
const CRON_SECRET = randomBytes(32).toString("hex");
const port = 5400 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: projectRoot,
  env: isolatedServerEnv({ ...process.env, ...SECRETS, ...mail.env, NODE_ENV: "production", DATA_DIR: dataDir, CRON_SECRET, CHECKOUT_ALERTS_BACKGROUND: "off", ML_BACKGROUND: "off", RESCANS_BACKGROUND: "off", NEXT_PUBLIC_APP_URL: base }),
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
  const p = browser();
  const f = browser();
  const anon = browser();
  assert.equal((await p("/api/auth/login", { method: "POST", body: { email: pro.email, password } })).status, 200);
  assert.equal((await f("/api/auth/login", { method: "POST", body: { email: free.email, password } })).status, 200);

  await check("1 the report shows smart-insight lines and, on Pro, the weekly-rescan switch", async () => {
    const page = await p(`/dashboard/reports/${proReport}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes("Estimated (rule-based): readiness index 64/100"));
    assert.ok(page.text.includes('role="switch"') && page.text.includes("Weekly rescans"));
  });

  await check("2 a Free account sees no switch, and the API refuses to turn it on", async () => {
    const page = await f(`/dashboard/reports/${freeReport}`);
    assert.ok(!page.text.includes('role="switch"'));
    const res = await f("/api/account/schedules", { method: "POST", body: { domain: "free-site.example", enabled: true } });
    assert.equal(res.status, 402, "FEATURE_LOCKED: an upgrade would allow it");
    assert.match(res.json.message, /doesn't include weekly rescans/);
  });

  await check("3 the API needs a login, a scanned site of your own, and a true/false", async () => {
    assert.equal((await anon("/api/account/schedules", { method: "POST", body: { domain: "pro-site.example", enabled: true } })).status, 401);
    assert.equal((await p("/api/account/schedules", { method: "POST", body: { domain: "free-site.example", enabled: true } })).status, 404, "another account's site");
    assert.equal((await p("/api/account/schedules", { method: "POST", body: { domain: "pro-site.example", enabled: "yes" } })).status, 400);
  });

  await check("4 turning it on schedules a week ahead; the page says when; turning it off keeps the row", async () => {
    const on = await p("/api/account/schedules", { method: "POST", body: { domain: "pro-site.example", enabled: true } });
    assert.equal(on.status, 200);
    assert.equal(on.json.enabled, true);
    assert.ok(on.json.nextRunAt > now + 6 * DAY && on.json.nextRunAt < now + 8 * DAY);
    const page = await p(`/dashboard/reports/${proReport}`);
    assert.ok(page.text.includes('aria-checked="true"') && page.text.includes("Next scan around"));
    const off = await p("/api/account/schedules", { method: "POST", body: { domain: "pro-site.example", enabled: false } });
    assert.equal(off.json.enabled, false);
    assert.equal(one("SELECT state_reason FROM scan_schedules WHERE user_id = ?", [pro.id]).state_reason, "Turned off by you.");
  });

  await check("5 the rescan scheduler endpoint needs CRON_SECRET and reports what it did", async () => {
    assert.equal((await anon("/api/internal/jobs/rescans", { method: "POST" })).status, 401);
    const res = await anon("/api/internal/jobs/rescans", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.match(res.json.summary, /^0 due/);
  });

  await check("6 nothing secret or internal reached the server log", () => {
    assert.ok(!serverLog.includes(CRON_SECRET));
    assert.ok(!/TypeError|ReferenceError|SqliteError/.test(serverLog), serverLog.slice(-500));
  });

  console.log(`smart insights over HTTP: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close?.();
  lib.cleanup();
}
process.exit(0);
