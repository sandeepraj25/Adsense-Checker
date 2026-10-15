// Scheduled jobs: the shared CRON_SECRET gate, the record of real
// scheduler calls, the admin status, and the scheduler client script.
//
//     npm run build && node scripts/scheduler-test.mjs
//
// Part A runs lib/scheduler.ts directly: health states (not configured,
// never called, verified, stale, failing) with a controllable clock.
// Part B starts the production build twice — without CRON_SECRET, then
// with it — and calls the three existing endpoints over HTTP, plus
// scripts/run-scheduled-jobs.mjs as a scheduler would.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";
import { isolatedServerEnv } from "./lib/server-env.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = { AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345", CREDENTIALS_SECRET: randomBytes(48).toString("base64") };
Object.assign(process.env, SECRETS, { NODE_ENV: "development" });
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "CRON_SECRET"]) delete process.env[name];

const lib = compileLib(projectRoot, "aec-scheduler-");
const dataDir = path.join(lib.workDir, "data");
process.env.DATA_DIR = dataDir;
const L = lib.require;
const scheduler = L("./scheduler.js");
const alertSettings = L("./alerts/settings.js");
const accounts = L("./db/accounts.js");
const { hashPasswordSync } = L("./auth/password.js");
const { run } = L("./db/index.js");

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

console.log("scheduled jobs");

/* ════════════════════ Part A — the library ════════════════════ */

const CRON_SECRET = randomBytes(32).toString("hex");
const MIN = 60_000;

await check("A1 without CRON_SECRET every job reads 'not configured'; a short secret is not enough", () => {
  for (const job of scheduler.SCHEDULED_JOBS) assert.equal(scheduler.scheduleHealth(job).state, "not_configured");
  process.env.CRON_SECRET = "too-short";
  assert.equal(scheduler.schedulerSecretConfigured(), false);
  process.env.CRON_SECRET = CRON_SECRET;
  assert.equal(scheduler.schedulerSecretConfigured(), true);
});

await check("A2 with a secret but no call yet: 'never called' — production scheduling is not claimed", () => {
  const h = scheduler.scheduleHealth("checkout-alerts");
  assert.equal(h.state, "never_called");
  assert.match(h.message, /not verified/i);
});

await check("A3 a recent successful call is 'verified'; 31 minutes later it is 'stale'; a failed call is 'failing'", () => {
  const t0 = Date.now();
  scheduler.recordSchedulerCall("ml", { at: t0, ok: true, summary: "0 deferred answers accepted" });
  assert.equal(scheduler.scheduleHealth("ml", t0 + 5 * MIN).state, "verified");
  assert.equal(scheduler.scheduleHealth("ml", t0 + 31 * MIN).state, "stale");
  scheduler.recordSchedulerCall("rescans", { at: t0, ok: false, summary: "The job failed; see the server log." });
  assert.equal(scheduler.scheduleHealth("rescans", t0 + MIN).state, "failing");
  assert.equal(scheduler.scheduleHealth("checkout-alerts", t0).state, "never_called", "jobs are tracked separately");
});

await check("A4 the alert job's own runs record who ran them; none of them counts as a scheduler call", () => {
  alertSettings.recordJobRun("x", Date.now(), "background");
  assert.equal(alertSettings.lastJobRun().trigger, "background");
  run("UPDATE app_settings SET value = ? WHERE key = 'alerts.job_last_run'", [JSON.stringify({ at: Date.now(), summary: "old row" })]);
  assert.equal(alertSettings.lastJobRun().trigger, null, "rows from before the trigger was recorded still read");
  assert.equal(scheduler.scheduleHealth("checkout-alerts").state, "never_called");
});

// Clean slate for Part B.
run("DELETE FROM app_settings WHERE key LIKE 'scheduler.last_call.%' OR key = 'alerts.job_last_run'");
delete process.env.CRON_SECRET;

/* ════════════════════ Part B — over HTTP ════════════════════ */

const password = "Str0ng-Password!";
const admin = accounts.createUser({ name: "Admin", email: `sched-admin-${Date.now()}@example.test`, passwordHash: hashPasswordSync(password), role: "admin" });
let serverLog = "";

function startServer(port, extra) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    cwd: projectRoot,
    env: isolatedServerEnv({
      ...process.env, ...SECRETS, NODE_ENV: "production", DATA_DIR: dataDir, NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
      CHECKOUT_ALERTS_BACKGROUND: "off", ML_BACKGROUND: "off", RESCANS_BACKGROUND: "off", ...extra,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));
  return child;
}
async function waitFor(base) {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${base} did not start`);
}
async function stop(child) {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
}
let ip = 10;
const call = async (base, pathname, { method = "POST", token, ip: from, body, cookie } = {}) => {
  const headers = new Headers({ "x-forwarded-for": from ?? `203.0.113.${(ip += 1) % 250}` });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && cookie) headers.set("origin", base);
  const res = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = (await res.text()).replace(/<!-- -->/g, "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie() };
};
async function login(base) {
  const r = await call(base, "/api/auth/login", { body: { email: admin.email, password } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  return r.setCookie.map((c) => c.split(";")[0]).join("; ");
}
const execFileP = promisify(execFile);
async function runClient(env, args = []) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, ["scripts/run-scheduled-jobs.mjs", ...args], { cwd: projectRoot, env: { PATH: process.env.PATH, ...env } });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}
const textOf = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const JOBS = ["checkout-alerts", "ml", "rescans"];
const portA = 5300 + Math.floor(Math.random() * 100);
const portB = portA + 1;
let child;
let exitCode = 0;
try {
  child = startServer(portA, {});
  const baseA = `http://127.0.0.1:${portA}`;
  await waitFor(baseA);

  await check("B1 without CRON_SECRET all three endpoints are shut (503), even with a token, and nothing runs", async () => {
    for (const job of JOBS) {
      const r = await call(baseA, `/api/internal/jobs/${job}`, { token: CRON_SECRET });
      assert.equal(r.status, 503, `${job}: ${r.text.slice(0, 120)}`);
      assert.match(r.json.message, /CRON_SECRET is missing/);
    }
    const page = textOf((await call(baseA, "/admin/settings/notifications", { method: "GET", cookie: await login(baseA) })).text);
    assert.match(page, /Scheduled jobs/);
    assert.equal((page.match(/Not configured/g) ?? []).length >= 3, true, "each job shows 'Not configured'");
    assert.match(page, /No scheduler is configured \(CRON_SECRET\)/);
  });

  await check("B2 the client script refuses to run without APP_URL or a full-length CRON_SECRET", async () => {
    const noUrl = await runClient({ CRON_SECRET });
    assert.equal(noUrl.code, 1);
    assert.match(noUrl.out, /set APP_URL/);
    const shortSecret = await runClient({ APP_URL: baseA, CRON_SECRET: "short" });
    assert.equal(shortSecret.code, 1);
    assert.match(shortSecret.out, /set CRON_SECRET/);
    const unknown = await runClient({ APP_URL: baseA, CRON_SECRET }, ["everything"]);
    assert.equal(unknown.code, 1);
  });

  await check("B3 against a server without the secret the client reports every job as failed (exit 1)", async () => {
    const r = await runClient({ APP_URL: baseA, CRON_SECRET });
    assert.equal(r.code, 1);
    for (const job of JOBS) assert.match(r.out, new RegExp(`FAIL ${job}: 503`));
    assert.ok(!r.out.includes(CRON_SECRET), "the secret is never printed");
  });
  await stop(child);

  child = startServer(portB, { CRON_SECRET });
  const baseB = `http://127.0.0.1:${portB}`;
  await waitFor(baseB);
  const adminCookie = await login(baseB);

  await check("B4 with CRON_SECRET: GET is 405; no token, a wrong token and a wrong-length token are 401", async () => {
    for (const job of JOBS) {
      assert.equal((await call(baseB, `/api/internal/jobs/${job}`, { method: "GET" })).status, 405);
      assert.equal((await call(baseB, `/api/internal/jobs/${job}`)).status, 401);
      assert.equal((await call(baseB, `/api/internal/jobs/${job}`, { token: CRON_SECRET.replace(/.$/, (c) => (c === "0" ? "1" : "0")) })).status, 401);
      assert.equal((await call(baseB, `/api/internal/jobs/${job}`, { token: `${CRON_SECRET}x` })).status, 401);
    }
    const page = textOf((await call(baseB, "/admin/settings/notifications", { method: "GET", cookie: adminCookie })).text);
    assert.match(page, /Not verified — never called/, "refused calls never count as a scheduler call");
  });

  await check("B5 an admin's Run now runs the alert job but does not verify the schedule", async () => {
    const r = await call(baseB, "/api/admin/notifications/run", { cookie: adminCookie });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const page = textOf((await call(baseB, "/admin/settings/notifications", { method: "GET", cookie: adminCookie })).text);
    assert.match(page, /by an admin \(Run now\)/);
    assert.match(page, /Scheduler not verified/);
  });

  await check("B6 the client script, as a scheduler, runs all three jobs with the right secret (exit 0)", async () => {
    const r = await runClient({ APP_URL: `${baseB}/`, CRON_SECRET });
    assert.equal(r.code, 0, r.out);
    for (const job of JOBS) assert.match(r.out, new RegExp(`ok   ${job} \\(\\d+ ms\\): \\S`));
    assert.match(r.out, /abandoned checkouts? found/);
    assert.match(r.out, /feedback emails? sent/);
    assert.ok(!r.out.includes(CRON_SECRET));
  });

  await check("B7 after real scheduler calls the admin page shows each job verified, with the time and summary", async () => {
    const page = textOf((await call(baseB, "/admin/settings/notifications", { method: "GET", cookie: adminCookie })).text);
    assert.equal((page.match(/Verified/g) ?? []).length >= 3, true, "all three verified");
    assert.match(page, /by the scheduler/, "the alert job's last run came from the scheduler");
    assert.ok(!page.includes("Scheduler not verified"));
    const rows = new DatabaseSync(path.join(dataDir, "app.db")).prepare("SELECT key FROM app_settings WHERE key LIKE 'scheduler.last_call.%' ORDER BY key").all();
    assert.deepEqual(rows.map((r) => r.key), JOBS.map((j) => `scheduler.last_call.${j}`).sort());
  });

  await check("B8 a stale schedule is reported: a last call over 30 minutes ago is 'not called recently'", async () => {
    const db = new DatabaseSync(path.join(dataDir, "app.db"));
    db.prepare("UPDATE app_settings SET value = json_set(value, '$.at', ?) WHERE key = 'scheduler.last_call.checkout-alerts'").run(Date.now() - 45 * MIN);
    db.close();
    const page = textOf((await call(baseB, "/admin/settings/notifications", { method: "GET", cookie: adminCookie })).text);
    assert.match(page, /Not called recently/);
    assert.match(page, /Scheduler not verified: The scheduler called before, but not recently/);
  });

  await check("B9 each job has its own rate limit: flooding one does not shut the others", async () => {
    const from = "198.51.100.77";
    let last;
    for (let i = 0; i < 31; i += 1) last = await call(baseB, "/api/internal/jobs/rescans", { ip: from });
    assert.equal(last.status, 429);
    assert.equal((await call(baseB, "/api/internal/jobs/ml", { ip: from, token: CRON_SECRET })).status, 200);
  });

  await check("B10 the secret never reaches the server log", async () => {
    assert.ok(!serverLog.includes(CRON_SECRET));
  });
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(serverLog.split("\n").slice(-20).join("\n"));
} finally {
  child?.kill();
}

console.log(`\nscheduled jobs: ${exitCode ? "stopped at the first failure" : "passed"} (${passed} checks)`);
process.exit(exitCode);
