// Website analytics.
//
//     npm run build && node scripts/analytics-test.mjs
//
// Part A runs the real lib/ modules (compiled to CommonJS, as verify.mjs
// does) against a temporary database, with explicit clocks: date ranges
// and comparisons, ingestion rules (validation, sessions, duplicates,
// bots, internal traffic, privacy), the visitor and session counting
// rules, funnels, account/scan/revenue figures (currency separation,
// pending/failed/test payments, duplicate payment events), empty periods,
// pagination, exports and retention.
//
// Part B starts the production build and checks the HTTP surface: who can
// see the pages and APIs, the collect endpoint's strict schema, CSV export
// and its permission, settings validation, and that every tab renders.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { registerVerified, startMailSink } from "./lib/mail-sink.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(path.join(tmpdir(), "aec-analytics-"));
const outDir = path.join(workDir, "build");
const dataDir = path.join(workDir, "data");
mkdirSync(dataDir, { recursive: true });

const SECRETS = {
  AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345",
  CREDENTIALS_SECRET: randomBytes(48).toString("base64"),
};
Object.assign(process.env, SECRETS, { DATA_DIR: dataDir, NODE_ENV: "development", EMAIL_PROVIDER: "console" });
for (const name of ["PAYMENTS_MODE", "ADMIN_EMAIL", "ADMIN_PASSWORD", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "ANALYTICS_COUNTRY_HEADER"]) {
  delete process.env[name];
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    if (error?.message?.length > 400) { error.message = `${error.message.slice(0, 300)}…`; delete error.actual; }
    console.log(`  ✗ ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function compileLib() {
  const tsconfig = path.join(workDir, "tsconfig.json");
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      target: "es2022", module: "commonjs", moduleResolution: "node", esModuleInterop: true, skipLibCheck: true,
      strict: true, outDir, rootDir: projectRoot, baseUrl: projectRoot, paths: { "@/*": ["./*"] }, types: ["node"],
      typeRoots: [path.join(projectRoot, "node_modules", "@types")],
    },
    include: [path.join(projectRoot, "lib/**/*.ts")],
  }));
  execFileSync(path.join(projectRoot, "node_modules", ".bin", "tsc"), ["-p", tsconfig], { stdio: "inherit" });
  const nodeModules = path.join(outDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(outDir, path.join(nodeModules, "@"), "dir");
  for (const pkg of ["libphonenumber-js", "sharp"]) {
    try { symlinkSync(path.join(projectRoot, "node_modules", pkg), path.join(nodeModules, pkg), "dir"); } catch { /* optional */ }
  }
}

/* Razorpay stand-in for the real verify flow. */
const realFetch = globalThis.fetch;
const scenario = { razorpayPayment: null };
let seq = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === "https://api.razorpay.com/v1/orders") return json(200, { id: `order_rzp_${++seq}` });
  if (url.startsWith("https://api.razorpay.com/v1/payments/")) return json(200, scenario.razorpayPayment);
  return json(404, { message: `no stub for ${url}` });
};

compileLib();
const req = createRequire(path.join(outDir, "lib", "x.js"));
const L = (m) => req(path.join(outDir, "lib", m));
const accounts = L("db/accounts.js");
const { hashPasswordSync } = L("auth/password.js");
const catalogue = L("plan-catalogue.js");
const payments = L("payments/index.js");
const cfg = L("payments/config.js");
const time = L("analytics/time.js");
const privacy = L("analytics/privacy.js");
const events = L("analytics/events.js");
const settingsMod = L("analytics/settings.js");
const store = L("analytics/store.js");
const traffic = L("analytics/traffic.js");
const funnel = L("analytics/funnel.js");
const business = L("analytics/business.js");
const report = L("analytics/report.js");
const exportsMod = L("analytics/exports.js");
const csv = L("analytics/csv.js");
const hooks = L("analytics/hooks.js");
const dbm = L("db/index.js");
const dbq = (sql, ...args) => dbm.many(sql, args);
const dbrun = (sql, ...args) => dbm.run(sql, args);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SETTINGS = { ...settingsMod.DEFAULT_SETTINGS };

console.log("website analytics");

/* ════════════════════ Part A — modules ════════════════════ */

await check("A1 date ranges are local-midnight boundaries in the reporting timezone, with equal-length comparisons", () => {
  // 13 Oct 2026, 15:00 IST = 09:30 UTC.
  const now = Date.UTC(2026, 9, 13, 9, 30);
  const tz = "Asia/Kolkata";
  const r7 = time.resolveRange({ preset: "last_7_days", tz, now });
  assert.equal(new Date(r7.start).toISOString(), "2026-10-06T18:30:00.000Z", "7 Oct 00:00 IST");
  assert.equal(r7.end, now, "cut at now");
  assert.equal(r7.days, 7);
  assert.equal(r7.partial, true);
  assert.equal(new Date(r7.previous.start).toISOString(), "2026-09-29T18:30:00.000Z");
  assert.equal(r7.previous.end - r7.previous.start, r7.end - r7.start, "same elapsed length");

  const today = time.resolveRange({ preset: "today", tz, now });
  assert.equal(new Date(today.start).toISOString(), "2026-10-12T18:30:00.000Z");
  assert.equal(today.previous.end - today.previous.start, now - today.start, "today so far vs yesterday until the same time");

  const y = time.resolveRange({ preset: "yesterday", tz, now });
  assert.equal(y.end - y.start, DAY);
  assert.equal(y.partial, false);

  const month = time.resolveRange({ preset: "this_month", tz, now });
  assert.equal(new Date(month.start).toISOString(), "2026-09-30T18:30:00.000Z");
  assert.equal(new Date(month.previous.start).toISOString(), "2026-08-31T18:30:00.000Z", "compared with September");
  assert.equal(month.previous.end - month.previous.start, now - month.start);

  const last = time.resolveRange({ preset: "last_month", tz, now });
  assert.equal(time.formatLocalDate(last.fromDate), "2026-09-01");
  assert.equal(time.formatLocalDate(last.toDate), "2026-09-30");
  assert.equal(time.formatLocalDate(last.previous.fromDate), "2026-08-01");
  assert.equal(time.formatLocalDate(last.previous.toDate), "2026-08-31", "a full August, not 30 days");

  const r90 = time.resolveRange({ preset: "last_90_days", tz, now });
  assert.equal(r90.days, 90);
  const r30 = time.resolveRange({ preset: "last_30_days", tz, now });
  assert.equal(r30.days, 30);
  assert.equal(time.resolveRange({ preset: "nonsense", tz, now }).preset, "last_30_days", "unknown preset falls back");
});

await check("A2 custom ranges are validated; DST days and weeks/months bucket correctly", () => {
  const now = Date.UTC(2026, 9, 13, 9, 30);
  const tz = "Asia/Kolkata";
  const c = time.resolveRange({ preset: "custom", from: "2026-10-01", to: "2026-10-05", tz, now });
  assert.equal(c.days, 5);
  assert.equal(c.end - c.start, 5 * DAY);
  assert.equal(new Date(c.previous.start).toISOString(), "2026-09-25T18:30:00.000Z");
  assert.match(time.resolveRange({ preset: "custom", from: "2026-10-05", to: "2026-10-01", tz, now }).error, /on or before/);
  assert.match(time.resolveRange({ preset: "custom", from: "2024-01-01", to: "2026-01-01", tz, now }).error, /at most 366/);
  assert.match(time.resolveRange({ preset: "custom", from: "2027-01-01", to: "2027-01-02", tz, now }).error, /future/);
  assert.match(time.resolveRange({ preset: "custom", from: "2026-02-30", to: "2026-03-01", tz, now }).error, /start and an end/);

  // US spring-forward: 8 Mar 2026 is a 23-hour day in New York.
  const ny = time.resolveRange({ preset: "custom", from: "2026-03-08", to: "2026-03-08", tz: "America/New_York", now });
  assert.equal(ny.end - ny.start, 23 * HOUR);

  const days = time.buckets(c, "day");
  assert.equal(days.length, 5);
  assert.equal(days[0].start, c.start);
  assert.equal(days.at(-1).end, c.end);
  const q = time.resolveRange({ preset: "custom", from: "2026-07-01", to: "2026-09-30", tz, now });
  const weeks = time.buckets(q, "week");
  assert.equal(weeks[0].start, q.start, "first week trimmed to the range");
  assert.equal(new Date(Date.UTC(2026, 5, 29)).getUTCDay(), 1);
  assert.equal(weeks[0].key, "2026-06-29", "weeks start on Monday");
  assert.equal(time.buckets(q, "month").map((b) => b.label).join(","), "Jul 2026,Aug 2026,Sep 2026");
  const total = weeks.reduce((s, b) => s + (b.end - b.start), 0);
  assert.equal(total, q.end - q.start, "buckets cover the range exactly");
  assert.equal(time.tzOffsetLabel(tz, now), "GMT+05:30");
});

await check("A3 privacy helpers keep only a cleaned path, a referrer host and campaign tags", () => {
  assert.equal(privacy.sanitizePath("/dashboard/reports/rep_8f2KqLmZx01?token=abc#x"), "/dashboard/reports/[id]");
  assert.equal(privacy.sanitizePath("/verify-email?code=123456&email=a@b.co"), "/verify-email");
  assert.equal(privacy.sanitizePath("/dashboard/billing/invoices/inv_ABCDEFGH1234"), "/dashboard/billing/invoices/[id]");
  assert.equal(privacy.sanitizePath("/u/someone@example.com"), "/u/[id]");
  assert.equal(privacy.sanitizePath("//evil.example/x"), null);
  assert.equal(privacy.sanitizePath("https://evil.example/"), null);
  assert.equal(privacy.sanitizePath("/a/%3Cscript%3E"), null);
  assert.equal(privacy.sanitizePath("/Pricing"), "/pricing");
  assert.equal(privacy.isExcludedPath("/admin/users"), true);
  assert.equal(privacy.referrerHost("https://www.google.com/search?q=adsense+help"), "google.com");
  assert.equal(privacy.referrerHost("javascript:alert(1)"), null);
  assert.equal(privacy.classifySource("google.co.in", null), "search");
  assert.equal(privacy.classifySource("t.co", null), "social");
  assert.equal(privacy.classifySource(null, null), "direct");
  assert.equal(privacy.classifySource("blog.example", null), "referral");
  assert.equal(privacy.classifySource("google.com", "cpc"), "paid");
  assert.equal(privacy.classifySource(null, "email"), "email");
  assert.deepEqual(privacy.sanitizeUtm({ utm_source: " Newsletter ", utm_medium: "me@example.com", utm_campaign: "<b>", foo: "bar" }), { utm_source: "newsletter" });
  assert.equal(privacy.isBot("curl/8.4"), true);
  assert.equal(privacy.isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
  assert.equal(privacy.isBot(CHROME.replace("Chrome/", "HeadlessChrome/")), true);
  assert.equal(privacy.isBot(CHROME), false);
  assert.deepEqual(privacy.parseUserAgent(IPHONE), { device: "mobile", browser: "Safari", os: "iOS" });
  assert.deepEqual(privacy.parseUserAgent(CHROME), { device: "desktop", browser: "Chrome", os: "Windows" });
  assert.equal(privacy.ipMatchesRule("198.51.100.77", "198.51.100.0/24"), true);
  assert.equal(privacy.ipMatchesRule("198.51.101.1", "198.51.100.0/24"), false);
  assert.equal(privacy.ipMatchesRule("::ffff:203.0.113.9", "203.0.113.9"), true);
  assert.equal(privacy.isValidIpRule("10.0.0.0/33"), false);
  assert.equal(privacy.isValidIpRule("not-an-ip"), false);
});

await check("A4 event names and properties follow a strict schema", () => {
  assert.equal(events.isEventName("page_view"), true);
  assert.equal(events.isEventName("purchase_completed"), false);
  assert.equal(events.CLIENT_EVENTS.has("payment_succeeded"), false, "browsers cannot report payments");
  assert.equal(events.CLIENT_EVENTS.has("signup_completed"), false);
  assert.deepEqual(events.validateProps("plan_selected", { plan: "pro", currency: "USD" }, { strict: true }), { plan: "pro", currency: "USD" });
  assert.equal(events.validateProps("plan_selected", { plan: "pro", amount: "1" }, { strict: true }), null);
  assert.equal(events.validateProps("plan_selected", { currency: "EUR" }, { strict: true }), null);
  assert.equal(events.validateProps("page_view", { email: "a@b.co" }, { strict: true }), null);
  assert.deepEqual(events.validateProps("scan_failed", { reason: "x y", plan: "free" }, { strict: false }), { plan: "free" });
});

await check("A5 settings are validated field by field", () => {
  const good = settingsMod.validateSettings({ ...SETTINGS });
  assert.equal(good.ok, true);
  const bad = settingsMod.validateSettings({ ...SETTINGS, timezone: "Mars/Olympus", retentionDays: 5, defaultRange: "custom", internalIps: ["1.2.3.4", "nope"], consentMode: "always", enabled: "yes" });
  assert.equal(bad.ok, false);
  for (const key of ["timezone", "retentionDays", "defaultRange", "internalIps", "consentMode", "enabled"]) assert.ok(bad.fields[key], key);
  assert.equal(settingsMod.validateSettings({ ...SETTINGS, retentionDays: 731 }).ok, false);
  assert.equal(settingsMod.validateSettings({ ...SETTINGS, internalIps: Array.from({ length: 26 }, (_, i) => `10.0.0.${i}`) }).ok, false);
  const dedupe = settingsMod.validateSettings({ ...SETTINGS, internalIps: [" 10.0.0.1 ", "10.0.0.1"] });
  assert.deepEqual(dedupe.settings.internalIps, ["10.0.0.1"]);
});

await check("A6 CSV cells cannot become spreadsheet formulas", () => {
  assert.equal(csv.csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csv.csvCell("-2+3"), "'-2+3");
  assert.equal(csv.csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csv.csvCell(-5), "-5", "numbers are not prefixed");
  assert.equal(csv.csvCell("a,b"), "\"a,b\"");
  assert.ok(csv.toCsv(["a"], [["₹"]]).startsWith("﻿a\r\n"));
});

/* ── ingestion ──────────────────────────────────────────────────── */

const T = Date.UTC(2031, 0, 6, 4, 0); // a quiet window of our own, 06 Jan 2031
const ev = (over = {}) => ({
  eventId: randomUUID(),
  name: "page_view",
  path: "/",
  referrerHost: null,
  utm: {},
  props: {},
  visitorId: null,
  ip: "203.0.113.10",
  userAgent: CHROME,
  userId: null,
  userIsAdmin: false,
  country: null,
  ownHost: "checker.example.test",
  now: T,
  ...over,
});
const ingest = (over, settings = SETTINGS) => store.ingestClientEvent(ev(over), settings);
const scopeT = (start = T - HOUR, end = T + 10 * DAY, includeInternal = false) => ({ start, end, includeInternal });

await check("A7 a visit is one browser with no 30-minute gap; duplicates and reloads are not counted twice", () => {
  const a = ingest({ path: "/", referrerHost: privacy.referrerHost("https://www.google.com/search?q=x"), utm: { utm_source: "news", utm_medium: "email", utm_campaign: "launch" } });
  assert.equal(a.status, "stored");
  assert.equal(a.newSession, true);
  const id = randomUUID();
  const b = ingest({ eventId: id, path: "/pricing", now: T + 5 * MIN });
  assert.equal(b.sessionId, a.sessionId, "same browser within 30 minutes");
  assert.equal(ingest({ eventId: id, path: "/pricing", now: T + 6 * MIN }).status, "duplicate", "same event id");
  assert.equal(ingest({ eventId: id.toUpperCase(), path: "/pricing", now: T + 6 * MIN }).status, "duplicate", "id case does not matter");
  const c1 = ingest({ name: "checkout_started", path: "/checkout", props: { plan: "pro", currency: "INR" }, now: T + 7 * MIN });
  assert.equal(c1.status, "stored");
  assert.equal(ingest({ name: "checkout_started", path: "/checkout", props: { plan: "pro", currency: "INR" }, now: T + 8 * MIN }).status, "duplicate", "reloading checkout");
  const later = ingest({ path: "/", now: T + 7 * MIN + 31 * MIN });
  assert.notEqual(later.sessionId, a.sessionId, "a 31-minute gap starts a new visit");
  const phone = ingest({ userAgent: IPHONE, now: T + 9 * MIN });
  assert.notEqual(phone.sessionId, a.sessionId, "another browser is another visitor");

  const s = dbq("SELECT * FROM analytics_sessions WHERE id = ?", a.sessionId)[0];
  assert.equal(s.page_views, 2);
  assert.equal(s.interactions, 1, "checkout_started is an interaction");
  assert.equal(s.landing_path, "/");
  assert.equal(s.exit_path, "/pricing");
  assert.equal(s.referrer_host, "google.com");
  assert.equal(s.referrer_type, "email", "utm_medium decides");
  assert.equal(s.utm_campaign, "launch");
  assert.equal(s.device, "desktop");
  assert.equal(dbq("SELECT COUNT(*) n FROM analytics_events WHERE session_id = ? AND name = 'session_started'", a.sessionId)[0].n, 1);
});

await check("A8 visitor, visit, page-view, bounce and duration rules give exact figures", () => {
  const t = traffic.trafficTotals(scopeT());
  // Visits: A (2 pages + checkout, 7 min), later (1 page), phone (1 page).
  assert.equal(t.sessions, 3);
  assert.equal(t.visitors, 2, "desktop Chrome and iPhone on one day");
  assert.equal(t.pageViews, 4);
  assert.equal(t.bounceRate, 2 / 3, "two one-page visits with no interaction");
  assert.equal(t.avgDurationMs, (7 * MIN + 0 + 0) / 3);
  assert.equal(t.pagesPerSession, 4 / 3);
  assert.equal(t.rememberedVisitors, 0, "cookie-free visitors cannot be classified new/returning");
  const pages = traffic.pagesTable(scopeT(), { sort: "views" });
  assert.deepEqual(pages.rows.map((r) => [r.path, r.views]), [["/", 3], ["/pricing", 1]]);
  assert.equal(pages.rows.find((r) => r.path === "/pricing").exits, 1);
  assert.equal(traffic.sessionsWith(scopeT(), "checkout_started"), 1);
  assert.deepEqual(traffic.campaigns(scopeT()).map((c) => [c.source, c.medium, c.campaign, c.sessions]), [["news", "email", "launch", 1]]);
  assert.deepEqual(traffic.deviceSplit(scopeT()).map((r) => [r.label, r.value]).sort(), [["desktop", 2], ["mobile", 1]]);
});

await check("A9 bots, admin pages, administrators and internal addresses are excluded; flag mode hides them by default", () => {
  assert.deepEqual(ingest({ userAgent: "curl/8.4.0" }), { status: "dropped", reason: "bot" });
  assert.deepEqual(ingest({ path: "/admin/users" }), { status: "dropped", reason: "excluded_path" });
  assert.deepEqual(ingest({ userIsAdmin: true, userId: "usr_admin" }), { status: "dropped", reason: "internal" });
  const office = { ...SETTINGS, internalIps: ["198.51.100.0/24"] };
  assert.deepEqual(ingest({ ip: "198.51.100.40" }, office), { status: "dropped", reason: "internal" });
  assert.equal(ingest({ userIsAdmin: true }, { ...SETTINGS, excludeAdmins: false }).status, "stored", "admins count only if the setting says so");
  assert.deepEqual(ingest({}, { ...SETTINGS, enabled: false }), { status: "dropped", reason: "disabled" });

  const flag = { ...office, internalMode: "flag" };
  const r = ingest({ ip: "198.51.100.41", userAgent: CHROME + " X", now: T + 2 * DAY }, flag);
  assert.equal(r.status, "stored");
  assert.equal(dbq("SELECT internal FROM analytics_sessions WHERE id = ?", r.sessionId)[0].internal, 1);
  const w = scopeT(T + 2 * DAY - HOUR, T + 2 * DAY + HOUR);
  assert.equal(traffic.trafficTotals(w).sessions, 0, "hidden by default");
  assert.equal(traffic.trafficTotals({ ...w, includeInternal: true }).sessions, 1);
  assert.equal(traffic.internalSessionCount(w), 1);
});

await check("A10 nothing personal is stored: no IP, user agent, email, query string or raw visitor id", () => {
  const vid = randomUUID();
  const r = ingest({ path: "/pricing", visitorId: vid, ip: "192.0.2.123", now: T + 3 * DAY }, { ...SETTINGS, consentMode: "ask" });
  assert.equal(r.status, "stored");
  const raw = JSON.stringify([...dbq("SELECT * FROM analytics_sessions"), ...dbq("SELECT * FROM analytics_events")]);
  for (const secret of ["192.0.2.123", "203.0.113.10", CHROME, vid, "token=", "code=", "@"]) assert.ok(!raw.includes(secret), `stored data must not contain ${secret}`);
  const s = dbq("SELECT visitor_key, visitor_persistent FROM analytics_sessions WHERE id = ?", r.sessionId)[0];
  assert.match(s.visitor_key, /^p:[A-Za-z0-9_-]{24}$/);
  assert.equal(s.visitor_persistent, 1);
  assert.equal(ingest({ visitorId: vid, ip: "192.0.2.124", now: T + 3 * DAY + MIN }, { ...SETTINGS, consentMode: "cookieless" }).sessionId === r.sessionId, false, "ids are ignored in cookie-free mode");
  // Salts rotate daily: the same address and browser hash differently tomorrow.
  assert.notEqual(store.dayHash("192.0.2.1", CHROME, T), store.dayHash("192.0.2.1", CHROME, T + DAY));
  assert.equal(store.dayHash("192.0.2.1", CHROME, T + DAY), store.dayHash("192.0.2.1", CHROME, T + DAY + HOUR));
});

await check("A11 remembered visitors are classified new or returning across days", () => {
  const consent = { ...SETTINGS, consentMode: "ask" };
  const vid = randomUUID();
  const d5 = T + 5 * DAY;
  ingest({ visitorId: vid, ip: "192.0.2.50", now: d5 }, consent);
  ingest({ visitorId: vid, ip: "192.0.2.51", now: d5 + DAY }, consent); // new address, next day: same visitor
  const fresh = randomUUID();
  ingest({ visitorId: fresh, ip: "192.0.2.52", now: d5 + DAY + HOUR }, consent);
  const t = traffic.trafficTotals(scopeT(d5 + DAY - HOUR, d5 + 2 * DAY));
  assert.equal(t.rememberedVisitors, 2);
  assert.equal(t.returningVisitors, 1);
  assert.equal(t.newVisitors, 1);
});

/* ── server events ──────────────────────────────────────────────── */

const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = accounts.createUser({ name: "Admin", email: `an-admin-${stamp}@example.test`, passwordHash: hashPasswordSync(password), role: "admin" });
const buyer = accounts.createUser({ name: "Kiran Rao", email: `an-buyer-${stamp}@example.test`, passwordHash: hashPasswordSync(password), emailVerifiedAt: Date.now() });

await check("A12 server events are idempotent, linked to the visitor's visit, and dropped for administrators", () => {
  const now = T + 7 * DAY;
  const visit = ingest({ ip: "203.0.113.70", now, userId: buyer.id });
  store.trackServerEvent("scan_started", { key: "scan:test-1", userId: buyer.id, props: { plan: "free" }, now: now + MIN });
  store.trackServerEvent("scan_started", { key: "scan:test-1", userId: buyer.id, props: { plan: "free" }, now: now + 2 * MIN });
  const rows = dbq("SELECT session_id, source FROM analytics_events WHERE event_key = 'x:scan:test-1'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, visit.sessionId, "attached to the account's open visit");
  assert.equal(rows[0].source, "server");
  store.trackServerEvent("email_verified", { key: "verified:ctx", context: { ip: "203.0.113.70", userAgent: CHROME }, now: now + 3 * MIN });
  assert.equal(dbq("SELECT session_id FROM analytics_events WHERE event_key = 'x:verified:ctx'")[0].session_id, visit.sessionId, "linked by the same browser");
  store.trackServerEvent("login_completed", { key: "login:admin", userId: admin.id, now });
  assert.equal(dbq("SELECT COUNT(*) n FROM analytics_events WHERE event_key = 'x:login:admin'")[0].n, 0);
  store.trackServerEvent("scan_failed", { key: "bad:props", userId: buyer.id, props: { reason: "free text!", email: "x@y.z" }, now });
  assert.equal(dbq("SELECT props_json FROM analytics_events WHERE event_key = 'x:bad:props'")[0].props_json, "{}");
  // A failing database must not throw into the caller.
  assert.doesNotThrow(() => store.trackServerEvent("scan_started", { key: null, now }));
});

await check("A13 the visitor journey counts each visitor once per step, in order", () => {
  const consent = { ...SETTINGS };
  const t0 = T + 20 * DAY;
  const steps = [
    ["page_view", "/"], ["pricing_viewed", "/pricing", { currency: "INR" }], ["plan_selected", "/pricing", { plan: "basic", currency: "INR" }],
    ["checkout_started", "/checkout", { plan: "basic", currency: "INR" }],
  ];
  const u1 = accounts.createUser({ name: "J1", email: `an-j1-${stamp}@example.test`, passwordHash: "x" });
  const u2 = accounts.createUser({ name: "J2", email: `an-j2-${stamp}@example.test`, passwordHash: "x" });
  // Visitor 1 goes all the way, repeating pricing twice.
  let t = t0;
  for (const [name, p, props] of steps) ingest({ name, path: p, props: props ?? {}, ip: "203.0.113.81", userId: u1.id, now: (t += MIN) }, consent);
  ingest({ name: "pricing_viewed", path: "/pricing", props: { currency: "INR" }, ip: "203.0.113.81", userId: u1.id, now: (t += MIN) }, consent);
  const live = { plan: "basic", currency: "INR", gateway: "razorpay", mode: "live" };
  store.trackServerEvent("checkout_details_saved", { key: "j1:details", userId: u1.id, props: { plan: "basic", currency: "INR" }, now: (t += MIN) });
  store.trackServerEvent("payment_attempted", { key: "j1:attempt", userId: u1.id, props: live, now: (t += MIN) });
  store.trackServerEvent("payment_succeeded", { key: "j1:paid", userId: u1.id, props: live, now: (t += MIN) });
  store.trackServerEvent("payment_succeeded", { key: "j1:paid", userId: u1.id, props: live, now: (t += MIN) }); // webhook repeat
  store.trackServerEvent("subscription_upgraded", { key: "j1:sub", userId: u1.id, props: { plan: "basic", kind: "first", mode: "live" }, now: (t += MIN) });
  store.trackServerEvent("scan_started", { key: "j1:scan", userId: u1.id, now: (t += MIN) });
  store.trackServerEvent("scan_completed", { key: "j1:scanok", userId: u1.id, now: (t += MIN) });
  // Visitor 2 scans BEFORE viewing pricing: the scan does not count as step 9.
  let t2 = t0;
  ingest({ ip: "203.0.113.82", userId: u2.id, now: (t2 += MIN) }, consent);
  store.trackServerEvent("scan_started", { key: "j2:scan", userId: u2.id, now: (t2 += MIN) });
  ingest({ name: "pricing_viewed", path: "/pricing", props: { currency: "USD" }, ip: "203.0.113.82", userId: u2.id, now: (t2 += MIN) }, consent);
  store.trackServerEvent("payment_attempted", { key: "j2:attempt", userId: u2.id, props: { ...live, plan: "pro" }, now: (t2 += MIN) });
  store.trackServerEvent("payment_failed", { key: "j2:failed", userId: u2.id, props: { ...live, reason: "FAILED" }, now: (t2 += MIN) });
  // Visitor 3 only looks.
  ingest({ ip: "203.0.113.83", now: t0 + MIN }, consent);
  // Test-mode payments never count as a verified payment.
  store.trackServerEvent("payment_succeeded", { key: "j2:mock", userId: u2.id, props: { ...live, mode: "mock" }, now: (t2 += MIN) });

  const f = funnel.journeyFunnel(scopeT(t0, t0 + DAY));
  assert.deepEqual(f.steps.map((s) => s.count), [3, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(f.steps[1].fromPrevious, 2 / 3);
  assert.equal(f.steps[1].dropOff, 1);
  assert.equal(f.overall, 1 / 3);
  assert.equal(f.extra.paymentFailed, 0, "visitor 2 never opened checkout, so never reached the payment step");
  assert.equal(f.unit, "visitors");
});

await check("A14 accounts, scans and revenue come from records; currencies are never mixed and only verified live payments count", () => {
  const w0 = T + 40 * DAY;
  const w = { start: w0, end: w0 + 10 * DAY };
  const at = (d) => w0 + d * DAY + HOUR;
  const u = (n, opts = {}) => {
    const user = accounts.createUser({ name: `R${n}`, email: `an-r${n}-${stamp}@example.test`, passwordHash: "x", role: opts.role });
    dbrun("UPDATE users SET created_at = ?, email_verified_at = ? WHERE id = ?", opts.at ?? at(1), opts.verified === false ? null : (opts.at ?? at(1)), user.id);
    return user;
  };
  const r1 = u(1);
  const r2 = u(2);
  const r3 = u(3, { verified: false });
  u(4, { role: "admin" });
  u(5, { at: w0 - DAY }); // before the window
  const pay = (user, status, currency, amount, mode, d, plan = "basic", gateway = "razorpay") =>
    dbrun(
      `INSERT INTO payments (id, user_id, plan_id, amount_paise, currency, status, mode, gateway_order_id, created_at, updated_at, verified_at, gateway, environment, receipt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 'r')`,
      `pay_${randomUUID()}`, user.id, plan, amount, currency, status, mode, `ord_${randomUUID()}`, at(d), at(d), status === "paid" ? at(d) : null, gateway,
    );
  pay(r1, "paid", "INR", 39900, "live", 2);
  pay(r1, "paid", "INR", 99900, "live", 3, "pro");
  pay(r2, "paid", "USD", 1900, "live", 2, "basic", "paypal");
  pay(r2, "failed", "USD", 1900, "live", 2);
  pay(r3, "created", "INR", 39900, "live", 4);
  pay(r3, "cancelled", "INR", 39900, "live", 4);
  pay(r3, "paid", "INR", 39900, "mock", 4); // test mode
  pay(r1, "paid", "INR", 39900, "live", 12); // after the window

  const site = (user) => {
    const id = `web_${randomUUID()}`;
    dbrun("INSERT INTO websites (id, user_id, domain, created_at) VALUES (?, ?, ?, ?)", id, user.id, `${id}.example`, w0);
    return id;
  };
  const scan = (user, state, d, plan = "free", extra = {}) =>
    dbrun(
      `INSERT INTO reports (id, ref, user_id, website_id, url, domain, plan_id, plan_name, engine_version, started_at, created_at, state, verdict, score, duration_ms, error_message)
       VALUES (?, ?, ?, ?, 'https://x.example', 'x.example', ?, ?, 'v', ?, ?, ?, ?, ?, ?, ?)`,
      `rep_${randomUUID()}`, `RPT-${randomUUID().slice(0, 6)}`, user.id, site(user), plan, plan === "free" ? "Free" : "Basic", at(d), at(d), state,
      extra.verdict ?? "not_ready", extra.score ?? 0, extra.duration ?? null, extra.error ?? null,
    );
  scan(r1, "complete", 1, "free", { verdict: "ready", score: 90, duration: 4000 });
  scan(r1, "complete", 3, "basic", { verdict: "not_ready", score: 40, duration: 8000 });
  scan(r2, "failed", 2, "free", { error: "The site took too long to answer." });
  scan(r2, "running", 2);

  const b = business.businessTotals(w);
  assert.equal(b.signups, 3, "admins and accounts outside the window excluded");
  assert.equal(b.verified, 2, "accounts with no recorded verification are not counted as verified");
  assert.equal(b.purchases, 3);
  assert.deepEqual(b.revenue, { INR: 39900 + 99900, USD: 1900 }, "per currency, mock/failed/pending excluded");
  assert.equal(b.scansStarted, 4);
  assert.equal(b.scansCompleted, 2);
  assert.equal(b.scanFailureRate, 1 / 3, "failed ÷ (completed + failed); running left out");

  const rev = business.revenueReport(w, []);
  assert.deepEqual(rev.gross, rev.net);
  assert.equal(rev.refunds, null, "refunds are not recorded, and not invented");
  assert.equal(rev.paidCount, 3);
  assert.equal(rev.failedCount, 1);
  assert.equal(rev.cancelledCount, 1);
  assert.equal(rev.pendingCount, 1);
  assert.equal(rev.testModePaid, 1);
  assert.equal(rev.successRate, 3 / 5);
  assert.equal(rev.newCustomers, 2);
  assert.equal(rev.returningCustomers, 0);
  assert.deepEqual(rev.byGateway.map((g) => [g.gateway, g.currency, g.amount]).sort(), [["paypal", "USD", 1900], ["razorpay", "INR", 139800]]);
  assert.ok(rev.byPlan.every((p) => p.currency === "INR" || p.currency === "USD"));
  const later = business.revenueReport({ start: w.end, end: w.end + 5 * DAY }, []);
  assert.equal(later.returningCustomers, 1, "a second purchase later is a returning customer");

  const s = business.scansReport(w, []);
  assert.equal(s.completionRate, 2 / 3);
  assert.equal(s.avgDurationMs, 6000);
  assert.equal(s.medianDurationMs, 4000);
  assert.deepEqual(s.verdicts.map((v) => v.label).sort(), ["Not ready", "Ready"]);
  assert.equal(s.failureReasons[0].label, "The site took too long to answer.");
  assert.equal(s.freeScanners, 2);
  assert.equal(s.freeScannersWhoPaid, 1, "r1 paid after a free scan; r2 paid at the same moment, not after");
  assert.equal(s.scanners, 2);

  const a = business.accountsReport(w, [], w.end);
  assert.equal(a.newUsers, 3);
  assert.equal(a.activeUsers, 3, "scan or payment in the window");
  assert.equal(a.returningUsers, 0);

  const af = funnel.accountFunnel(w);
  assert.deepEqual(af.steps.map((st) => st.count), [3, 0, 0, 0, 0, 0], "no saved checkouts, so the closed funnel stops at step 2");
  dbrun(
    `INSERT INTO checkout_sessions (id, user_id, plan_id, plan_name, currency, amount_minor, billing_name, billing_email, created_at, details_saved_at, updated_at)
     VALUES (?, ?, 'basic', 'Basic', 'INR', 39900, 'R1', 'r1@example.test', ?, ?, ?)`,
    `chk_${randomUUID()}`, r1.id, at(2), at(2), at(2),
  );
  assert.deepEqual(funnel.accountFunnel(w).steps.map((st) => st.count), [3, 1, 1, 1, 1, 1]);
});

await check("A15 a verified payment is recorded once, however many times it is confirmed", async () => {
  cfg.saveGatewayCredentials({ id: "razorpay", values: { keyId: "rzp_test_abc", keySecret: "rzp_secret_xyz", webhookSecret: "rzp_wh_secret" }, enabled: true, actorEmail: admin.email });
  const order = await payments.startCheckout({
    userId: buyer.id, plan: catalogue.requirePlan("basic"), currency: "INR", gateway: "razorpay",
    customerName: "Kiran", customerEmail: "kiran@example.test",
    billing: { name: "Kiran Rao", email: "kiran@example.test", phone: "+919876543210", country: "IN" },
    returnUrl: "http://127.0.0.1/r", idempotencyKey: randomUUID(),
  });
  assert.equal(order.ok, true);
  const paymentId = "pay_ANALYTICS1";
  scenario.razorpayPayment = { id: paymentId, order_id: order.orderId, status: "captured", amount: order.amountPaise, currency: "INR", method: "card" };
  const sig = createHmac("sha256", "rzp_secret_xyz").update(`${order.orderId}|${paymentId}`).digest("hex");
  const payload = { razorpay_order_id: order.orderId, razorpay_payment_id: paymentId, razorpay_signature: sig };
  assert.equal((await payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId, payload })).status, "fulfilled");
  assert.equal((await payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId, payload })).status, "already");
  hooks.recordPaymentSucceeded(order.orderId); // as a late webhook would
  const rows = dbq("SELECT name, props_json FROM analytics_events WHERE event_key IN (?, ?)", `x:paid:${order.orderId}`, `x:failed:${order.orderId}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "payment_succeeded");
  assert.deepEqual(JSON.parse(rows[0].props_json), { plan: "basic", currency: "INR", gateway: "razorpay", mode: "live" });
  assert.equal(dbq("SELECT COUNT(*) n FROM analytics_events WHERE name = 'subscription_upgraded' AND user_id = ?", buyer.id)[0].n, 1);
  assert.equal(dbq("SELECT COUNT(*) n FROM payments WHERE gateway_order_id = ?", order.orderId)[0].n, 1, "one payment row: revenue counts it once");
});

await check("A16 an empty period and a period before tracking return zeros, not invented history", () => {
  const empty = { start: Date.UTC(2001, 0, 1), end: Date.UTC(2001, 1, 1), includeInternal: false };
  const t = traffic.trafficTotals(empty);
  assert.equal(t.sessions, 0);
  assert.equal(t.bounceRate, null);
  assert.equal(t.avgDurationMs, null);
  assert.equal(t.pagesPerSession, null);
  const b = business.businessTotals(empty);
  assert.equal(b.scanFailureRate, null);
  assert.deepEqual(b.revenue, { INR: 0, USD: 0 });
  assert.equal(funnel.journeyFunnel(empty).overall, null);
  const cov = report.coverageFor(empty);
  assert.equal(cov.state, "none");
  const startedAt = store.trackingStartedAt();
  const partial = report.coverageFor({ start: startedAt - DAY, end: startedAt + DAY });
  assert.equal(partial.state, "partial");
  assert.equal(partial.tracked.start, startedAt, "conversion uses only the tracked part");
  const q = report.parseReportQuery({ range: "custom", from: "2001-01-01", to: "2001-01-31", tab: "overview" }, SETTINGS);
  const o = report.overview(q);
  assert.equal(o.coverage.state, "none");
  assert.equal(o.kpis.find((k) => k.key === "visitors").value, null, "not 0 — unknown");
  assert.match(o.kpis.find((k) => k.key === "visitors").unavailable, /No tracked visits/);
  assert.equal(o.kpis.find((k) => k.key === "signups").value, 0, "records still answer");
  assert.equal(o.kpis.length, 15);
  assert.ok(o.series.buckets.length === 31);
});

await check("A17 tables paginate, and every export builds with the right columns", () => {
  for (let i = 0; i < 20; i++) ingest({ path: `/page-${String(i).padStart(2, "0")}`, ip: "203.0.113.90", now: T + 30 * DAY + i * MIN });
  const w = scopeT(T + 30 * DAY - HOUR, T + 31 * DAY);
  const p1 = traffic.pagesTable(w, { page: 1, pageSize: 15, sort: "path" });
  const p2 = traffic.pagesTable(w, { page: "2", pageSize: 15, sort: "path" });
  assert.equal(p1.total, 20);
  assert.equal(p1.rows.length, 15);
  assert.equal(p2.rows.length, 5);
  assert.equal(p2.rows[0].path, "/page-15");
  assert.equal(traffic.pagesTable(w, { page: "999", pageSize: 15 }).page, 2, "out-of-range page is clamped");
  const users = business.usersTable({ page: 1, pageSize: 2 });
  assert.equal(users.rows.length, 2);
  assert.equal(users.total, 7, "buyer, two journey accounts and four record accounts");
  assert.ok(!users.rows.some((r) => r.email.startsWith("an-admin-")), "administrators are not listed");

  ingest({ path: "/", utm: { utm_source: "-2+3", utm_campaign: "spring" }, ip: "203.0.113.91", userAgent: IPHONE, now: T + 30 * DAY + HOUR });
  const q = report.parseReportQuery({ range: "custom", from: "2031-02-04", to: "2031-02-06" }, { ...SETTINGS, timezone: "UTC" }, Date.UTC(2031, 5, 1));
  for (const name of Object.keys(exportsMod.EXPORTS)) {
    const out = exportsMod.buildExport(name, q, SETTINGS);
    assert.ok(out.csv.startsWith("﻿"), name);
    assert.match(out.filename, /^analytics-[a-z0-9-]+-?[\d_-]*\.csv$/, name);
  }
  const camp = exportsMod.buildExport("campaigns", q, SETTINGS).csv;
  assert.match(camp, /'-2\+3/, "formula-like values are neutralised");
  const noEmail = exportsMod.buildExport("users", q, SETTINGS).csv;
  assert.ok(!noEmail.includes("@example.test"), "emails left out by default");
  const withEmail = exportsMod.buildExport("users", q, { ...SETTINGS, exportIncludesEmail: true }).csv;
  assert.ok(withEmail.includes("@example.test"));
});

await check("A18 retention deletes old visits and events", () => {
  const before = dbq("SELECT COUNT(*) n FROM analytics_events WHERE occurred_at < ?", T + 10 * DAY)[0].n;
  assert.ok(before > 0);
  const result = store.purgeAnalytics(T + 10 * DAY + 30 * DAY, { ...SETTINGS, retentionDays: 30 });
  assert.ok(result.events >= before);
  assert.equal(dbq("SELECT COUNT(*) n FROM analytics_events WHERE occurred_at < ?", T + 10 * DAY)[0].n, 0);
  assert.equal(dbq("SELECT COUNT(*) n FROM analytics_sessions WHERE last_seen_at < ?", T + 10 * DAY)[0].n, 0);
  assert.ok(store.lastPurge().at > 0);
});

await check("A19 deleting an account unlinks it from analytics", () => {
  const u = accounts.createUser({ name: "Gone", email: `an-gone-${stamp}@example.test`, passwordHash: "x" });
  ingest({ userId: u.id, ip: "203.0.113.99", now: T + 60 * DAY });
  assert.ok(dbq("SELECT COUNT(*) n FROM analytics_events WHERE user_id = ?", u.id)[0].n > 0);
  dbrun("DELETE FROM users WHERE id = ?", u.id);
  assert.equal(dbq("SELECT COUNT(*) n FROM analytics_events WHERE user_id = ?", u.id)[0].n, 0);
  assert.equal(dbq("SELECT COUNT(*) n FROM analytics_sessions WHERE user_id = ?", u.id)[0].n, 0);
});

globalThis.fetch = realFetch;

/* ════════════════════ Part B — HTTP ════════════════════ */

dbrun("DELETE FROM analytics_events");
dbrun("DELETE FROM analytics_sessions");

const mail = await startMailSink();
const port = 5300 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: projectRoot,
  env: { ...process.env, ...SECRETS, ...mail.env, NODE_ENV: "production", DATA_DIR: dataDir, CHECKOUT_ALERTS_BACKGROUND: "off", NEXT_PUBLIC_APP_URL: base },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let ipn = 0;
function browser({ ua = CHROME } = {}) {
  const jar = new Map();
  const ip = `198.18.0.${(ipn += 1)}`;
  return async (pathname, { method = "GET", body, headers = {}, raw } = {}) => {
    const h = new Headers({ "x-forwarded-for": ip, "user-agent": ua, ...headers });
    if (jar.size) h.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (method !== "GET" && !headers.origin) h.set("origin", base);
    if (body !== undefined || raw !== undefined) h.set("content-type", "application/json");
    const res = await fetch(`${base}${pathname}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair.split("=");
      if (/Max-Age=0/i.test(c)) jar.delete(k); else jar.set(k, v.join("="));
    }
    const text = (await res.text()).replace(/<!-- -->/g, "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* html or csv */ }
    return { status: res.status, json: parsed, text, headers: res.headers };
  };
}
const q = (sql, ...a) => {
  const h = new DatabaseSync(path.join(dataDir, "app.db"));
  h.exec("PRAGMA busy_timeout = 5000");
  try { return h.prepare(sql).all(...a); } finally { h.close(); }
};
const pv = (over = {}) => ({ id: randomUUID(), name: "page_view", path: "/", ...over });

try {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const staff = browser();
  assert.equal((await staff("/api/auth/login", { method: "POST", body: { email: admin.email, password } })).status, 200);
  const cust = browser();
  assert.equal((await cust("/api/auth/login", { method: "POST", body: { email: buyer.email, password } })).status, 200);
  const anon = browser();

  await check("B1 only administrators can open the analytics pages", async () => {
    const r = await anon("/admin/analytics");
    assert.equal(r.status, 307);
    assert.match(r.headers.get("location"), /\/login\?next=%2Fadmin%2Fanalytics/);
    assert.equal((await cust("/admin/analytics")).status, 404);
    assert.equal((await cust("/admin/analytics/settings")).status, 404);
    const page = await staff("/admin/analytics");
    assert.equal(page.status, 200);
    assert.match(page.text, /Website analytics/);
    assert.match(page.text, /Asia\/Kolkata \(GMT\+05:30\)/, "the reporting timezone is shown");
    assert.match(page.text, /compared with/);
  });

  await check("B2 the analytics APIs check the session themselves", async () => {
    assert.equal((await anon("/api/admin/analytics")).status, 401);
    assert.equal((await cust("/api/admin/analytics")).status, 403);
    assert.equal((await cust("/api/admin/analytics/export?dataset=users")).status, 403);
    assert.equal((await cust("/api/admin/analytics/settings")).status, 403);
    assert.equal((await cust("/api/admin/analytics/settings", { method: "PATCH", body: { ...SETTINGS, enabled: false } })).status, 403);
    const r = await staff("/api/admin/analytics?tab=revenue&range=last_7_days");
    assert.equal(r.status, 200);
    assert.equal(r.json.tab, "revenue");
    assert.equal(r.json.range.timezone, "Asia/Kolkata");
    assert.ok("gross" in r.json.data.report);
    const bad = await staff("/api/admin/analytics?range=custom&from=2026-10-05&to=2026-10-01");
    assert.equal(bad.status, 400);
    const acc = await staff("/api/admin/analytics?tab=accounts");
    assert.ok(acc.json.data.users.rows.length > 0);
    assert.ok(acc.json.data.users.rows.every((row) => !("email" in row)), "the JSON API leaves emails out");
  });

  await check("B3 the collect endpoint accepts only browser events in the strict shape", async () => {
    const v = browser();
    let r = await v("/api/analytics/collect", { method: "POST", body: pv({ path: "/pricing?code=123456&email=a%40b.co", referrer: "https://www.google.com/search?q=secret", utm: { utm_source: "news" } }) });
    assert.equal(r.status, 202);
    assert.equal(r.json.status, "stored");
    assert.equal(r.json.consent, "none");
    const stored = q("SELECT path FROM analytics_events WHERE name = 'page_view'");
    assert.deepEqual(stored.map((s) => s.path), ["/pricing"], "query string dropped");
    assert.equal(q("SELECT referrer_host FROM analytics_sessions")[0].referrer_host, "google.com");
    for (const [body, why] of [
      [pv({ name: "payment_succeeded" }), "server-only event"],
      [pv({ name: "made_up" }), "unknown event"],
      [{ ...pv(), extra: 1 }, "unknown field"],
      [pv({ id: "not-a-uuid" }), "bad id"],
      [pv({ path: "https://evil.example/" }), "absolute URL"],
      [pv({ props: { plan: "pro" } }), "page_view takes no props"],
      [pv({ name: "plan_selected", props: { plan: "pro", price: "1" } }), "unknown prop"],
      [pv({ vid: "123" }), "bad visitor id"],
      [pv({ utm: "x" }), "bad utm"],
    ]) {
      r = await v("/api/analytics/collect", { method: "POST", body });
      assert.equal(r.status, 400, why);
      assert.equal(r.json.code, "VALIDATION_ERROR", why);
    }
    assert.equal((await v("/api/analytics/collect", { method: "POST", raw: JSON.stringify(pv({ path: `/${"a".repeat(5000)}` })) })).status, 400, "oversized");
    assert.equal((await v("/api/analytics/collect", { method: "POST", raw: "{oops" })).status, 400);
    assert.equal((await v("/api/analytics/collect", { method: "POST", body: pv(), headers: { origin: "https://evil.example" } })).status, 403, "cross-site posts are refused");
  });

  await check("B4 duplicates, bots and administrators are not recorded", async () => {
    const v = browser();
    const e = pv({ path: "/team" });
    assert.equal((await v("/api/analytics/collect", { method: "POST", body: e })).json.status, "stored");
    assert.equal((await v("/api/analytics/collect", { method: "POST", body: e })).json.status, "duplicate");
    const bot = browser({ ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" });
    assert.equal((await bot("/api/analytics/collect", { method: "POST", body: pv() })).json.status, "dropped");
    assert.equal((await browser({ ua: "node" })("/api/analytics/collect", { method: "POST", body: pv() })).json.status, "dropped");
    assert.equal((await staff("/api/analytics/collect", { method: "POST", body: pv() })).json.status, "dropped", "signed-in admin");
    const c = await cust("/api/analytics/collect", { method: "POST", body: pv({ path: "/dashboard" }) });
    assert.equal(c.json.status, "stored");
    assert.equal(q("SELECT user_id FROM analytics_events WHERE path = '/dashboard' AND name = 'page_view'")[0].user_id, buyer.id, "linked to the signed-in customer");
    assert.equal(q("SELECT COUNT(*) n FROM analytics_events WHERE path = '/team' AND name = 'page_view'")[0].n, 1);
  });

  await check("B5 a real sign-in is recorded once by the server", async () => {
    const before = q("SELECT COUNT(*) n FROM analytics_events WHERE name = 'login_completed' AND user_id = ?", buyer.id)[0].n;
    const again = browser();
    await again("/api/analytics/collect", { method: "POST", body: pv({ path: "/login" }) });
    assert.equal((await again("/api/auth/login", { method: "POST", body: { email: buyer.email, password } })).status, 200);
    const rows = q("SELECT session_id FROM analytics_events WHERE name = 'login_completed' AND user_id = ? ORDER BY occurred_at DESC", buyer.id);
    assert.equal(rows.length, before + 1);
    assert.ok(rows[0].session_id, "attached to that browser's visit");
    assert.equal((await again("/api/auth/login", { method: "POST", body: { email: buyer.email, password: "wrong-password" } })).status, 401);
    assert.equal(q("SELECT COUNT(*) n FROM analytics_events WHERE name = 'login_completed' AND user_id = ?", buyer.id)[0].n, before + 1, "a failed login is not a login");
  });

  await check("B5b sign-up forms and verified accounts are server events; an existing address is not counted", async () => {
    const email = `an-new-${stamp}@example.test`;
    await registerVerified({ base, mail, name: "Asha Verma", email, password });
    const user = q("SELECT id FROM users WHERE email = ?", email)[0];
    assert.equal(q("SELECT COUNT(*) n FROM analytics_events WHERE name = 'signup_completed'")[0].n, 1);
    assert.equal(q("SELECT COUNT(*) n FROM analytics_events WHERE name = 'email_verified' AND user_id = ?", user.id)[0].n, 1);
    // The look-alike flow for an already-registered address sends no code to count.
    const r = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "user-agent": CHROME },
      body: JSON.stringify({ name: "Someone", email, password, confirmPassword: password }),
    });
    assert.equal(r.status, 202);
    assert.equal(q("SELECT COUNT(*) n FROM analytics_events WHERE name = 'signup_completed'")[0].n, 1);
    const raw = JSON.stringify(q("SELECT * FROM analytics_events"));
    assert.ok(!raw.includes(email), "no email address in events");
  });

  await check("B6 settings are validated, saved, audit-logged and take effect", async () => {
    let r = await staff("/api/admin/analytics/settings", { method: "PATCH", body: { ...SETTINGS, timezone: "Nowhere/City", retentionDays: 1 } });
    assert.equal(r.status, 400);
    assert.ok(r.json.fields.timezone && r.json.fields.retentionDays);
    r = await staff("/api/admin/analytics/settings", { method: "PATCH", body: { ...SETTINGS, timezone: "UTC", consentMode: "ask" } });
    assert.equal(r.status, 200);
    assert.equal(q("SELECT COUNT(*) n FROM admin_logs WHERE action = 'analytics.settings_updated'")[0].n, 1);
    const page = await staff("/admin/analytics");
    assert.match(page.text, /UTC \(GMT\+00:00\)/);
    const v = browser();
    assert.equal((await v("/api/analytics/collect", { method: "POST", body: pv() })).json.consent, "ask", "the tracker learns it should ask");
    r = await staff("/api/admin/analytics/settings", { method: "PATCH", body: { ...SETTINGS, enabled: false } });
    assert.equal(r.status, 200);
    const off = await v("/api/analytics/collect", { method: "POST", body: pv() });
    assert.equal(off.json.enabled, false);
    const status = await staff("/api/admin/analytics/settings");
    assert.equal(status.json.settings.enabled, false);
    assert.ok(status.json.status.lastBrowserEventAt > 0, "last event time is reported");
    assert.equal((await staff("/api/admin/analytics/settings", { method: "PATCH", body: { ...SETTINGS } })).status, 200);
  });

  await check("B7 CSV export works for admins, is logged, and can be switched off", async () => {
    const r = await staff("/api/admin/analytics/export?dataset=pages&range=last_7_days");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/csv/);
    assert.match(r.headers.get("content-disposition"), /attachment; filename="analytics-pages-/);
    assert.match(r.text, /^﻿?path,views,visits,landings,exits,exit_rate_pct/);
    assert.match(r.text, /\/pricing/);
    const users = await staff("/api/admin/analytics/export?dataset=users");
    assert.ok(!users.text.includes(buyer.email), "no emails unless the setting allows it");
    assert.equal((await staff("/api/admin/analytics/export?dataset=nope")).status, 400);
    assert.ok(q("SELECT COUNT(*) n FROM admin_logs WHERE action = 'analytics.exported'")[0].n >= 2);
    await staff("/api/admin/analytics/settings", { method: "PATCH", body: { ...SETTINGS, exportEnabled: false } });
    const blocked = await staff("/api/admin/analytics/export?dataset=pages");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, "FORBIDDEN");
    const page = await staff("/admin/analytics?tab=traffic");
    assert.ok(!page.text.includes("/api/admin/analytics/export"), "no export links when exports are off");
    await staff("/api/admin/analytics/settings", { method: "PATCH", body: { ...SETTINGS } });
  });

  await check("B8 every tab, the settings page and custom ranges render from real data", async () => {
    for (const tab of ["overview", "traffic", "funnel", "accounts", "scans", "revenue", "health"]) {
      const r = await staff(`/admin/analytics?tab=${tab}&range=last_90_days&interval=week`);
      assert.equal(r.status, 200, tab);
      assert.ok(!/This section couldn.t be loaded/.test(r.text), `${tab} rendered without error`);
    }
    const traffic = await staff("/admin/analytics?tab=traffic&range=today");
    assert.match(traffic.text, /\/pricing/);
    assert.match(traffic.text, /google\.com/);
    const health = await staff("/admin/analytics?tab=health");
    assert.match(health.text, /Core Web Vitals/);
    assert.match(health.text, /Not measured/);
    const settings = await staff("/admin/analytics/settings");
    assert.equal(settings.status, 200);
    assert.match(settings.text, /Tracking is on and receiving visits/);
    const bad = await staff("/admin/analytics?range=custom&from=2026-10-05&to=2026-10-01");
    assert.match(bad.text, /That date range couldn.t be used/);
    const nav = await staff("/admin");
    assert.match(nav.text, /href="\/admin\/analytics"/, "sidebar link");
  });

  await check("B9 the public pages still work and nothing secret reached the log", async () => {
    for (const p of ["/", "/pricing", "/login", "/signup"]) assert.equal((await anon(p)).status, 200, p);
    assert.ok(!serverLog.includes(SECRETS.AUTH_SECRET));
    assert.ok(!/\[analytics\]/.test(serverLog), `no analytics errors in the server log:\n${serverLog.slice(-800)}`);
  });

  console.log(`website analytics: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close();
  rmSync(workDir, { recursive: true, force: true });
}
