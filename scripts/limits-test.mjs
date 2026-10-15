// Phase 5: admin-configurable usage limits.
//
//     npm run build && node scripts/limits-test.mjs
//
// Part A runs the real lib/ modules: the V15 upgrade, plan validation,
// the pages-per-scan fallbacks, the crawl cap against a local fixture
// site, the atomic claim (quota race, a site already running, the
// per-account running limit), refunds, the background job runner, the
// heartbeat sweep and the monthly reset (yearly plans included).
//
// Part B starts the production build on the same database, with the same
// fixture DNS loaded into the server process, and checks a scan over HTTP:
// queued with 202, readable while running, refused while running, capped
// at the plan's pages, the limit message, and the admin plan editor API.
//
// Fixture names (*-fixture.com) are resolved to 127.0.0.1 inside these
// processes only. A scan started through the API reads a site on the
// standard port 80; the fixture site listens on a free high port instead
// (or LIMITS_FIXTURE_PORT), and scripts/fixtures/dns-hook.mjs sends
// connections to fixture names on port 80 there — in this process and the
// server's — so no privileged port or special rights are needed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import { compileLib } from "./lib/compile-lib.mjs";
import { isolatedServerEnv } from "./lib/server-env.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = { AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345", CREDENTIALS_SECRET: randomBytes(48).toString("base64") };
Object.assign(process.env, SECRETS, { NODE_ENV: "development", ANALYSIS_DEADLINE_MS: "20000" });
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ANALYSIS_DEMO_FALLBACK", "ALLOW_PRIVATE_ANALYSIS_HOSTS", "ANALYSIS_CONCURRENT_JOBS"]) delete process.env[name];

/* ── fixture DNS, for this process and (via --import) the server ── */



const lib = compileLib(projectRoot, "aec-limits-");
const dataDir = path.join(lib.workDir, "data");
process.env.DATA_DIR = dataDir;
const hookFile = path.join(projectRoot, "scripts", "fixtures", "dns-hook.mjs");
await import(hookFile);
void dns; void dnsPromises;
const L = lib.require;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    if (error && typeof error.message === "string" && error.message.length > 400) {
      error.message = `${error.message.slice(0, 300)}…`;
      delete error.actual;
    }
    console.log(`  ✗ ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, every = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(every);
  }
}

/* ── the fixture site: 90 linked posts, policy pages, a sitemap ── */

const POSTS = 90;
const hits = [];
const page = (title, body, links) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${title} — a page of the pages fixture."></head><body>
<nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/contact/">Contact</a></nav>
<main><h1>${title}</h1>${body}${links.map((href) => `<p><a href="${href}">Read ${href}</a></p>`).join("")}</main>
<footer><a href="/privacy-policy/">Privacy Policy</a> · <a href="/terms/">Terms of Use</a></footer></body></html>`;
const prose = (n) => `<p>${`Post ${n} walks through one careful idea about gardening in small spaces, with notes from a real balcony and what changed after a season. `.repeat(12)}</p>`;
const postLinks = (n) => Array.from({ length: 6 }, (_, k) => n * 6 + k + 1).filter((m) => m <= POSTS).map((m) => `/post-${m}/`);
let slowMs = 0;
const site = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const host = String(req.headers.host ?? "").split(":")[0];
  hits.push({ host, path: url.pathname, method: req.method, at: Date.now() });
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  if (url.pathname === "/robots.txt") return send(200, "text/plain", `User-agent: *\nAllow: /\nSitemap: http://${host}/sitemap.xml\n`);
  if (url.pathname === "/sitemap.xml") {
    const urls = Array.from({ length: POSTS }, (_, i) => `<url><loc>http://${host}/post-${i + 1}/</loc></url>`).join("");
    return send(200, "application/xml", `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  }
  if (url.pathname === "/ads.txt") return send(404, "text/plain", "no");
  if (url.pathname === "/") return send(200, "text/html", page("Balcony Garden", prose(0), postLinks(0)));
  const policy = { "/privacy-policy/": "Privacy Policy", "/about/": "About us", "/contact/": "Contact", "/terms/": "Terms of Use" }[url.pathname];
  if (policy) return send(200, "text/html", page(policy, `<p>${`${policy} for Balcony Garden: we use cookies and Google AdSense, and you can write to hello@balcony.example. `.repeat(8)}</p>`, []));
  const post = /^\/post-(\d+)\/$/.exec(url.pathname);
  if (post && Number(post[1]) <= POSTS) {
    if (slowMs) await sleep(slowMs);
    return send(200, "text/html", page(`Post ${post[1]}`, prose(post[1]), postLinks(Number(post[1]))));
  }
  return send(404, "text/html", "<h1>Not found</h1>");
});
const wantedPort = Number.parseInt(process.env.LIMITS_FIXTURE_PORT ?? "0", 10) || 0;
try {
  await new Promise((resolve, reject) => site.once("error", reject).listen(wantedPort, "127.0.0.1", resolve));
} catch (error) {
  console.error(`Could not listen on 127.0.0.1:${wantedPort} (${error.code ?? error}). Free that port or set LIMITS_FIXTURE_PORT.`);
  process.exit(1);
}
const FIXTURE_PORT = site.address().port;
// Port 80 needs no redirect; any other port gets one (read by dns-hook.mjs).
if (FIXTURE_PORT !== 80) process.env.FIXTURE_HTTP_PORT = String(FIXTURE_PORT);
// Pages read (GET); the broken-link check only sends HEAD requests.
const postsRead = (host, since) => hits.filter((h) => h.method === "GET" && h.host === host && h.at >= since && /^\/post-\d+\/$/.test(h.path)).map((h) => h.path);
const policiesRead = (host, since) => hits.filter((h) => h.method === "GET" && h.host === host && h.at >= since && /^\/(privacy-policy|about|contact|terms)\/$/.test(h.path)).map((h) => h.path);

/* ── modules ─────────────────────────────────────────────────────── */

const { MIGRATIONS } = L("./db/schema.js");
const { one, run } = L("./db/index.js");
const accounts = L("./db/accounts.js");
const billing = L("./db/billing.js");
const audits = L("./db/audits.js");
const catalogue = L("./plan-catalogue.js");
const limits = L("./limits.js");
const plans = L("./plans.js");
const engine = L("./analysis/engine.js");
const fetcher = L("./analysis/fetcher.js");
const types = L("./analysis/types.js");
const service = L("./audit-service.js");
const jobs = L("./scans/jobs.js");
const cycle = L("./billing/cycle.js");
const { hashPasswordSync } = L("./auth/password.js");

const password = "correct horse battery staple 42";
const stamp = Date.now();
let seq = 0;
const newUser = (plan, extra = {}) => {
  seq += 1;
  const user = accounts.createUser({ name: `Limits ${seq}`, email: `limits-${stamp}-${seq}@example.test`, passwordHash: hashPasswordSync(password), ...extra });
  const sub = plan ? billing.createSubscription({ userId: user.id, plan: catalogue.requirePlan(plan), paymentStatus: plan === "free" ? "free" : "paid" }) : null;
  return { user: accounts.findUserById(user.id), sub };
};
const adminActor = { id: "admin-limits", email: "admin@example.test" };

console.log("Phase 5 — usage limits");

/* ════════════════════ Part A — the library ════════════════════ */

await check("A1 V15 upgrades a version-14 database: pages per scan seeded 1/25/200, scan limits kept, old rows have no snapshot", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(MIGRATIONS.length, 15);
  for (const sql of MIGRATIONS.slice(0, 14)) db.exec(sql);
  const seeded = db.prepare("SELECT COUNT(*) AS n FROM plans").get().n;
  if (seeded === 0) {
    for (const [id, name, scans] of [["free", "Free", 10], ["basic", "Basic", 100], ["pro", "Pro", 300]]) {
      // Whatever the version-14 table requires, filled with plain values.
      const required = db.prepare("PRAGMA table_info(plans)").all().filter((c) => c.notnull && c.dflt_value === null && !["id", "name", "scan_limit"].includes(c.name));
      const cols = ["id", "name", "scan_limit", ...required.map((c) => c.name)];
      const values = [id, name, scans, ...required.map((c) => (/TEXT/i.test(c.type) ? "" : 1))];
      db.prepare(`INSERT INTO plans (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...values);
    }
  }
  db.prepare("UPDATE plans SET scan_limit = 77 WHERE id = 'basic'").run();
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES ('u', 'U', 'u@x.test', 'h', 1, 1)").run();
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_id, plan_name, amount_paise, scan_limit, validity_days, purchased_at, starts_at, expires_at, status, payment_status, created_at, updated_at)
              VALUES ('s', 'u', 'basic', 'Basic', 39900, 77, 30, 1, 1, 2, 'active', 'paid', 1, 1)`).run();
  db.exec(MIGRATIONS[14]);
  const pages = Object.fromEntries(db.prepare("SELECT id, pages_per_scan FROM plans").all().map((r) => [r.id, r.pages_per_scan]));
  assert.deepEqual(pages, { free: 1, basic: 25, pro: 200 });
  assert.equal(db.prepare("SELECT scan_limit FROM plans WHERE id = 'basic'").get().scan_limit, 77, "the admin's scan limit is untouched");
  assert.equal(db.prepare("SELECT page_limit FROM subscriptions WHERE id = 's'").get().page_limit, null);
  const cols = db.prepare("PRAGMA table_info(reports)").all().map((c) => c.name);
  for (const c of ["error_code", "heartbeat_at", "page_limit"]) assert.ok(cols.includes(c), c);
  db.close();
});

await check("A2 a fresh database ships 1 / 25 / 200 pages per scan and keeps the existing scan limits", () => {
  const got = Object.fromEntries(catalogue.listPlans().map((p) => [p.id, [p.pagesPerScan, p.scanLimit]]));
  assert.deepEqual(got.free[0], 1);
  assert.deepEqual(got.basic[0], 25);
  assert.deepEqual(got.pro[0], 200);
  for (const id of ["free", "basic", "pro"]) assert.equal(got[id][1], plans.PLANS[id].scanLimit);
});

await check("A3 the plan editor refuses 0, 501, 2.5 and text for pages per scan; accepts 40 and logs the change", () => {
  for (const bad of [0, 501, 2.5, "ten", -3]) {
    const r = catalogue.updatePlan("basic", { pagesPerScan: bad }, adminActor);
    assert.equal(r.ok, false, `refuses ${bad}`);
  }
  const ok = catalogue.updatePlan("basic", { pagesPerScan: 40, scanLimit: 120 }, adminActor);
  assert.equal(ok.ok, true);
  assert.equal(catalogue.getPlan("basic").pagesPerScan, 40);
  assert.ok(ok.changed.some((line) => /pages\/scan 25 → 40/.test(line)), ok.changed.join(" | "));
  assert.equal(catalogue.updatePlan("basic", { pagesPerScan: 25, scanLimit: plans.PLANS.basic.scanLimit }, adminActor).ok, true);
});

await check("A4 pages per scan: the subscription's snapshot, else the plan's current value, else the shipped one; clamped to 1..500", () => {
  assert.equal(limits.pagesPerScanFor({ planId: "basic", pageLimit: 7 }), 7);
  assert.equal(limits.pagesPerScanFor({ planId: "pro", pageLimit: null }), 200);
  run("UPDATE plans SET pages_per_scan = NULL WHERE id = 'pro'");
  assert.equal(catalogue.getPlan("pro").pagesPerScan, 200, "a plan without a value reads as the shipped default");
  run("UPDATE plans SET pages_per_scan = 200 WHERE id = 'pro'");
  assert.equal(limits.pagesPerScanFor({ planId: "basic", pageLimit: 9999 }), plans.MAX_PAGES_PER_SCAN);
  assert.equal(limits.pagesPerScanFor({ planId: "basic", pageLimit: 0 }), 1);
});

await check("A5 a purchase snapshots the plan's pages per scan; a plan edit reaches it at the next monthly reset", () => {
  assert.equal(newUser("basic").sub.pageLimit, 25);
  // A yearly plan, so the subscription outlives the month and rolls.
  const { user } = newUser(null);
  const sub = billing.createSubscription({ userId: user.id, plan: catalogue.requirePlan("basic"), paymentStatus: "paid", billingCycle: "yearly" });
  assert.equal(sub.pageLimit, 25);
  catalogue.updatePlan("basic", { pagesPerScan: 30 }, adminActor);
  assert.equal(billing.findSubscription(sub.id).pageLimit, 25, "unchanged mid-month");
  billing.consumeScan(sub.id);
  const later = billing.findSubscription(sub.id).cycleEnd + 1000;
  billing.rollBillingCycles(later);
  const rolled = billing.findSubscription(sub.id);
  assert.deepEqual([rolled.pageLimit, rolled.scansUsed], [30, 0]);
  catalogue.updatePlan("basic", { pagesPerScan: 25 }, adminActor);
});

await check("A6 a yearly subscription gets a fresh allowance every calendar month", () => {
  const { user } = newUser(null);
  const t0 = Date.UTC(2026, 0, 15, 6, 0, 0);
  const sub = billing.createSubscription({ userId: user.id, plan: catalogue.requirePlan("pro"), paymentStatus: "paid", billingCycle: "yearly", now: t0 });
  assert.equal(sub.expiresAt, cycle.addCalendarMonths(t0, 12));
  for (let month = 1; month <= 3; month += 1) {
    for (let i = 0; i < 4; i += 1) billing.consumeScan(sub.id, cycle.addCalendarMonths(t0, month - 1) + 1000);
    assert.equal(billing.findSubscription(sub.id).scansUsed, 4);
    billing.rollBillingCycles(cycle.addCalendarMonths(t0, month) + 1000);
    const s = billing.findSubscription(sub.id);
    assert.equal(s.scansUsed, 0, `month ${month} resets`);
    assert.equal(s.cycleEnd, cycle.addCalendarMonths(t0, month + 1));
  }
});

await check("A7 the crawl stops at the plan's pages: 1, 5 and 25 content pages; policy pages read on top", async () => {
  const features = plans.PLANS.pro.features;
  for (const [limit, label] of [[1, "one"], [5, "five"], [25, "twentyfive"]]) {
    const host = `${label}-fixture.com`;
    const since = Date.now();
    const outcome = await engine.runAnalysis(`http://${host}/`, features, { pageLimit: limit });
    const posts = new Set(postsRead(host, since));
    assert.equal(posts.size, limit - 1, `${limit}: homepage + ${limit - 1} posts (read ${posts.size})`);
    assert.ok(policiesRead(host, since).length >= 3, `${limit}: policy pages still read`);
    assert.ok(outcome.pagesFetched >= limit, `${limit}: pagesFetched ${outcome.pagesFetched}`);
    assert.ok(outcome.pagesFetched <= limit + 4, `${limit}: pagesFetched ${outcome.pagesFetched} includes at most 4 policy pages`);
  }
});

await check("A8 without a page limit the engine behaves as before Phase 5 (2–6 pages by plan)", async () => {
  const host = "legacy-fixture.com";
  const since = Date.now();
  const outcome = await engine.runAnalysis(`http://${host}/`, plans.PLANS.free.features);
  assert.ok(outcome.pagesFetched <= 2, `free legacy read ${outcome.pagesFetched}`);
  assert.ok(postsRead(host, since).length <= 1);
});

await check("A9 the scan's time limit grows with its pages and is capped", () => {
  assert.equal(engine.scanDeadlineMs(1), 20_000);
  assert.equal(engine.scanDeadlineMs(26), 20_000 + 20 * 600);
  assert.equal(engine.scanDeadlineMs(500), 240_000);
});

/* ── the service, with the network and the engine stood in ───────── */

const realPreflight = fetcher.preflight;
const realRunAnalysis = engine.runAnalysis;
fetcher.preflight = async () => ({ ok: true });
const gates = new Map(); // domain -> { promise, release, fail }
const seenOptions = [];
let template = null;
engine.runAnalysis = async (domain, features, options) => {
  seenOptions.push({ domain, options });
  const gate = gates.get(domain);
  if (gate) await gate.promise;
  if (gate?.error) throw gate.error;
  return template;
};
const hold = (domain) => {
  let release;
  const promise = new Promise((r) => (release = r));
  const gate = { promise, release: () => release(), fail: (error) => { gate.error = error; release(); } };
  gates.set(domain, gate);
  return gate;
};
template = await realRunAnalysis("http://template-fixture.com/", plans.PLANS.pro.features, { pageLimit: 3 });
const stateOf = (id) => one("SELECT state, error_code, page_limit FROM reports WHERE id = ?", [id]);

await check("A10 a queued scan returns at once with a running report, the plan's page limit, and one scan used", async () => {
  const { user, sub } = newUser("basic");
  const gate = hold("queued-a.com");
  const r = await service.startAudit(user, "queued-a.com");
  assert.deepEqual([r.ok, r.queued, r.report.state], [true, true, "running"]);
  assert.equal(stateOf(r.report.id).page_limit, 25);
  assert.equal(billing.findSubscription(sub.id).scansUsed, 1);
  assert.ok(jobs.scanJobStats().tracked >= 1, "the job is tracked for heartbeats");
  await until(() => seenOptions.some((s) => s.domain === "queued-a.com"));
  assert.equal(seenOptions.find((s) => s.domain === "queued-a.com").options.pageLimit, 25);
  gate.release();
  await until(() => stateOf(r.report.id).state === "complete");
  assert.equal(billing.findSubscription(sub.id).scansUsed, 1, "a finished scan stays counted");
});

await check("A11 while a site is being scanned, a second scan of it is refused (409) and costs nothing", async () => {
  const { user, sub } = newUser("basic");
  const gate = hold("busy.com");
  const first = await service.startAudit(user, "busy.com");
  const second = await service.startAudit(user, "www.busy.com");
  assert.equal(second.code, "SCAN_IN_PROGRESS");
  assert.match(second.message, /already running/);
  assert.equal(billing.findSubscription(sub.id).scansUsed, 1);
  gate.release();
  await until(() => stateOf(first.report.id).state === "complete");
});

await check("A12 at most two scans run per account; a third is refused and costs nothing", async () => {
  const { user, sub } = newUser("pro");
  const g1 = hold("one.com");
  const g2 = hold("two.com");
  const a = await service.startAudit(user, "one.com");
  const b = await service.startAudit(user, "two.com");
  const c = await service.startAudit(user, "three.com");
  assert.deepEqual([a.ok, b.ok, c.code], [true, true, "SCAN_IN_PROGRESS"]);
  assert.match(c.message, /2 scans running.*nothing has been counted/);
  assert.equal(billing.findSubscription(sub.id).scansUsed, 2);
  g1.release();
  g2.release();
  await until(() => stateOf(a.report.id).state === "complete" && stateOf(b.report.id).state === "complete");
  assert.equal((await service.startAudit(user, "three.com", { wait: true })).ok, true, "allowed once one finishes");
});

await check("A13 twenty scans fired together with one scan left: exactly one starts, nothing is over-spent", async () => {
  const { user, sub } = newUser("pro");
  run("UPDATE subscriptions SET scan_limit = 5, scans_used = 4 WHERE id = ?", [sub.id]);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => service.startAudit(user, `race-${i}.com`)));
  const started = results.filter((r) => r.ok);
  assert.equal(started.length, 1, results.map((r) => r.code ?? "ok").join(","));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "LIMIT_REACHED" || r.code === "SCAN_IN_PROGRESS"));
  assert.equal(billing.findSubscription(sub.id).scansUsed, 5);
  assert.equal(one("SELECT COUNT(*) AS n FROM reports WHERE subscription_id = ?", [sub.id]).n, 1);
  await until(() => stateOf(started[0].report.id).state === "complete");
});

await check("A14 the limit message names the allowance, the plan and the reset date", async () => {
  const { user, sub } = newUser("free");
  run("UPDATE subscriptions SET scans_used = scan_limit WHERE id = ?", [sub.id]);
  const r = await service.startAudit(user, "capped.com");
  assert.equal(r.code, "LIMIT_REACHED");
  const s = billing.findSubscription(sub.id);
  assert.match(r.message, new RegExp(`^Monthly scan limit reached\\. You've used all ${s.scanLimit} scans on the Free plan this month`));
  assert.match(r.message, /your allowance resets on .+\. Upgrade your plan to scan again sooner\.$/);
  assert.equal(one("SELECT COUNT(*) AS n FROM reports WHERE subscription_id = ?", [sub.id]).n, 0, "no report row for a refused scan");
});

await check("A15 a scan that fails on our side is marked failed with a code and refunded", async () => {
  const { user, sub } = newUser("basic");
  const quiet = console.error;
  console.error = () => {};
  try {
    const gate = hold("broken.com");
    const r = await service.startAudit(user, "broken.com");
    gate.fail(new Error("boom"));
    await until(() => stateOf(r.report.id).state === "failed");
    assert.equal(stateOf(r.report.id).error_code, "ANALYSIS_FAILED");
    assert.equal(billing.findSubscription(sub.id).scansUsed, 0);
    const gate2 = hold("down.com");
    const r2 = await service.startAudit(user, "down.com");
    gate2.fail(new types.AnalysisFailure("The site did not answer.", true));
    await until(() => stateOf(r2.report.id).state === "failed");
    assert.equal(stateOf(r2.report.id).error_code, "SITE_UNREACHABLE");
    assert.equal(audits.findReport(r2.report.id).errorMessage, "The site did not answer.");
    assert.equal(billing.findSubscription(sub.id).scansUsed, 0);
  } finally {
    console.error = quiet;
  }
});

await check("A16 waiting callers (weekly rescans) get the finished report or the failure", async () => {
  const { user } = newUser("basic");
  const r = await service.startAudit(user, "waiter.com", { wait: true });
  assert.deepEqual([r.ok, r.report.state, r.queued], [true, "complete", undefined]);
});

await check("A17 jobs queue beyond ANALYSIS_CONCURRENT_JOBS instead of running all at once", async () => {
  process.env.ANALYSIS_CONCURRENT_JOBS = "1";
  try {
    let releaseA;
    const a = jobs.runScanJob("job-a", () => new Promise((r) => (releaseA = r)));
    const b = jobs.runScanJob("job-b", async () => "b");
    await sleep(20);
    assert.deepEqual([jobs.scanJobStats().active, jobs.scanJobStats().waiting], [1, 1]);
    releaseA("a");
    assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
    assert.equal(await jobs.runScanJob("job-c", async () => { throw new Error("escaped"); }).catch(() => "threw"), undefined, "an escaping error is logged, never thrown");
  } finally {
    delete process.env.ANALYSIS_CONCURRENT_JOBS;
  }
});

await check("A18 a long scan that keeps beating is left alone; one whose heartbeat stopped is failed and refunded once", async () => {
  const { user, sub } = newUser("basic");
  const gLong = hold("long.com");
  const gDead = hold("dead.com");
  const long = await service.startAudit(user, "long.com");
  const dead = await service.startAudit(user, "dead.com");
  const longAgo = Date.now() - 10 * 60_000;
  run("UPDATE reports SET started_at = ? WHERE id IN (?, ?)", [longAgo, long.report.id, dead.report.id]);
  audits.heartbeatReports([long.report.id]);
  run("UPDATE reports SET heartbeat_at = ? WHERE id = ?", [Date.now() - 120_000, dead.report.id]);
  assert.equal(audits.failStaleReports(), 1);
  assert.equal(stateOf(long.report.id).state, "running");
  const d = audits.findReport(dead.report.id);
  assert.deepEqual([d.state, d.errorCode], ["failed", "ANALYSIS_FAILED"]);
  assert.match(d.errorMessage, /returned to your monthly allowance/);
  assert.equal(billing.findSubscription(sub.id).scansUsed, 1);
  assert.equal(audits.failStaleReports(), 0);
  gLong.release();
  gDead.release();
  await until(() => stateOf(long.report.id).state === "complete");
  await sleep(50);
  assert.equal(stateOf(dead.report.id).state, "failed", "a late finish does not revive a swept scan");
  assert.equal(billing.findSubscription(sub.id).scansUsed, 1);
});

fetcher.preflight = realPreflight;
engine.runAnalysis = realRunAnalysis;

/* ════════════════════ Part B — over HTTP ════════════════════ */

const { user: admin } = newUser(null, { role: "admin" });
const { user: buyer, sub: buyerSub } = newUser("basic");
const { user: freeUser, sub: freeSub } = newUser("free");

const port = 5700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: projectRoot,
  env: isolatedServerEnv({
    ...process.env, ...SECRETS, NODE_ENV: "production", DATA_DIR: dataDir, NEXT_PUBLIC_APP_URL: base,
    NODE_OPTIONS: `--import ${pathToFileURL(hookFile).href}`,
    ...(process.env.FIXTURE_HTTP_PORT ? { FIXTURE_HTTP_PORT: process.env.FIXTURE_HTTP_PORT } : {}),
    CHECKOUT_ALERTS_BACKGROUND: "off", ML_BACKGROUND: "off", RESCANS_BACKGROUND: "off",
  }),
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function call(pathname, { method = "GET", body, cookie } = {}) {
  const headers = new Headers({ "x-forwarded-for": `198.51.100.${(seq++ % 200) + 1}` });
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET") headers.set("origin", base);
  if (body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = (await res.text()).replace(/<!-- -->/g, "");
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json: data, text, setCookie: res.headers.getSetCookie() };
}
async function login(email) {
  const r = await call("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(r.status, 200, `login ${email}: ${r.text.slice(0, 200)}`);
  return r.setCookie.map((c) => c.split(";")[0]).join("; ");
}

let exitCode = 0;
try {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await sleep(100);
  }
  const adminCookie = await login(admin.email);
  const buyerCookie = await login(buyer.email);
  const freeCookie = await login(freeUser.email);

  await check("B1 POST /api/analysis answers 202 at once with a running report; a second scan of the site gets 409", async () => {
    slowMs = 400;
    const since = Date.now();
    const r = await call("/api/analysis", { method: "POST", body: { url: "http-fixture.com" }, cookie: buyerCookie });
    assert.equal(r.status, 202, r.text.slice(0, 300));
    assert.deepEqual([r.json.queued, r.json.state], [true, "running"]);
    const again = await call("/api/analysis", { method: "POST", body: { url: "http-fixture.com" }, cookie: buyerCookie });
    assert.deepEqual([again.status, again.json.code], [409, "SCAN_IN_PROGRESS"]);
    const reading = await call(`/api/reports/${r.json.reportId}`, { cookie: buyerCookie });
    assert.equal(reading.json.report.state, "running");
    const done = await until(async () => {
      const x = await call(`/api/reports/${r.json.reportId}`, { cookie: buyerCookie });
      return x.json.report.state !== "running" ? x.json.report : null;
    }, 90_000, 500);
    assert.equal(done.state, "complete", JSON.stringify({ code: done.errorCode, msg: done.errorMessage }));
    const posts = new Set(postsRead("http-fixture.com", since));
    assert.equal(posts.size, 24, `Basic reads 25 content pages: homepage + ${posts.size} posts`);
    assert.ok(done.pagesFetched >= 25 && done.pagesFetched <= 29, `pagesFetched ${done.pagesFetched}`);
    assert.equal(billing.findSubscription(buyerSub.id).scansUsed, 1);
    slowMs = 0;
  });

  await check("B2 the checker page and the dashboard show scans left and pages per scan", async () => {
    const checker = await call("/dashboard/checker", { cookie: buyerCookie });
    assert.match(checker.text, /up to <span[^>]*>25<\/span> pages per scan/);
    const dash = await call("/dashboard", { cookie: buyerCookie });
    assert.match(dash.text, /up to 25 pages per scan/);
    const billingPage = await call("/dashboard/billing", { cookie: buyerCookie });
    assert.match(billingPage.text, /Pages per scan/);
  });

  await check("B3 out of scans: 402 LIMIT_REACHED with the reset date, nothing recorded; the checker says so", async () => {
    run("UPDATE subscriptions SET scans_used = scan_limit WHERE id = ?", [freeSub.id]);
    const before = one("SELECT COUNT(*) AS n FROM reports WHERE user_id = ?", [freeUser.id]).n;
    const r = await call("/api/analysis", { method: "POST", body: { url: "free-fixture.com" }, cookie: freeCookie });
    assert.deepEqual([r.status, r.json.code], [402, "LIMIT_REACHED"]);
    assert.match(r.json.message, /resets on/);
    assert.equal(one("SELECT COUNT(*) AS n FROM reports WHERE user_id = ?", [freeUser.id]).n, before);
    const page = await call("/dashboard/checker", { cookie: freeCookie });
    assert.match(page.text, /Monthly scan limit reached/);
  });

  await check("B4 admins change pages per scan without a redeploy; bad values are refused", async () => {
    const bad = await call("/api/admin/plans/free", { method: "PATCH", body: { pagesPerScan: 0 }, cookie: adminCookie });
    assert.equal(bad.status, 400, bad.text.slice(0, 200));
    const tooMany = await call("/api/admin/plans/free", { method: "PATCH", body: { pagesPerScan: 9000 }, cookie: adminCookie });
    assert.equal(tooMany.status, 400);
    const ok = await call("/api/admin/plans/free", { method: "PATCH", body: { pagesPerScan: 3, scanLimit: 12 }, cookie: adminCookie });
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    assert.deepEqual([catalogue.getPlan("free").pagesPerScan, catalogue.getPlan("free").scanLimit], [3, 12]);
    const editor = await call("/admin/plans", { cookie: adminCookie });
    assert.match(editor.text, /Pages per scan/);
    assert.match(editor.text, /Resets every month, yearly plans included/);
    const denied = await call("/api/admin/plans/free", { method: "PATCH", body: { pagesPerScan: 50 }, cookie: buyerCookie });
    assert.ok(denied.status === 401 || denied.status === 403, String(denied.status));
  });
  await check("B5 a request cannot raise its own limits: extra plan, feature and page fields are ignored", async () => {
    const { user: bypass } = newUser("free");
    const cookie = await login(bypass.email);
    const r = await call("/api/analysis", {
      method: "POST", cookie,
      body: { url: "bypass-fixture.com", plan: "pro", planId: "pro", features: plans.PLANS.pro.features, pageLimit: 500, pagesPerScan: 500, wait: true },
    });
    assert.equal(r.status, 202, r.text.slice(0, 200));
    const row = one("SELECT page_limit, plan_id, features_json FROM reports WHERE id = ?", [r.json.reportId]);
    assert.equal(row.page_limit, catalogue.getPlan("free").pagesPerScan);
    assert.equal(row.plan_id, "free");
    assert.deepEqual(JSON.parse(row.features_json).sort(), [...billing.getActiveSubscription(bypass.id).features].sort());
    await until(() => one("SELECT state FROM reports WHERE id = ?", [r.json.reportId]).state !== "running", 60_000, 300);
  });
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(serverLog.split("\n").slice(-30).join("\n"));
} finally {
  server.kill();
  site.close();
}

console.log(`\n${passed} passed${exitCode ? ", stopped at the first failure" : ""}`);
process.exit(exitCode);
