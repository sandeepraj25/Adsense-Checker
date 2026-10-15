// @ts-check
/**
 * Integration checks for the money, entitlement and address-filter paths.
 *
 *     npm run verify
 *
 * There is no test framework here on purpose: the project has zero test
 * dependencies, and these checks exercise the real modules against a real
 * (throwaway) SQLite file rather than mocks. What is covered:
 *
 *   · the plan catalogue — three monthly tiers, their prices, their
 *     10/100/300 allowances, and which features each one actually carries
 *   · signup validation, scrypt hashing, duplicate accounts, sessions
 *   · the address filter: which URLs are accepted, which are refused, and
 *     that a refusal costs the customer nothing
 *   · monthly cycles — a spent allowance blocks, a rolled cycle refills,
 *     and an admin's new limit lands at the roll rather than mid-month
 *   · checkout in mock mode, then the same order settled twice
 *   · forged and mismatched payments, and closed orders
 *   · signed Razorpay webhooks: settle once, ignore a redelivery, refuse a
 *     bad signature, and never touch a row for an order we do not have
 *   · gateway credentials — encrypted at rest, masked on the way out, and
 *     never enabled half-configured
 *   · feature gating both ways: a locked feature produces no metric, and a
 *     feature removed from a plan is not clawed back mid-month
 *   · admin actions: block, unblock, re-price, and the audit trail
 *   · the stale-run sweep, including the credit-back it promises
 *
 * How it works: lib/ is compiled to a temp directory as CommonJS, the
 * "@/..." path alias is satisfied with a symlink, and the compiled
 * modules are required directly. That skips Next entirely, so this runs
 * anywhere Node 22.5+ runs — including CI with no browser and no network.
 * Name resolution is switched off for this process (below), so scans fall
 * through to the demo engine on every machine, connected or not — which
 * is why every scan below asserts on structure rather than on content.
 *
 * Exits non-zero on the first failing expectation count.
 */

import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(path.join(tmpdir(), "verdict-verify-"));
const outDir = path.join(workDir, "build");
const dataDir = path.join(workDir, "data");

// This suite asserts the offline path (demo reports, no pages fetched), so
// it makes the machine offline for this process: every name except
// localhost fails to resolve, exactly as on a machine without a network.
// Without this, a run on a connected computer scanned the real example.com
// and example.org, and the offline assertions depended on where it ran.
const offline = (host) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host });
const isLocal = (host) => host === "localhost" || host === "127.0.0.1" || host === "::1";
const realLookup = dns.lookup;
const realPromiseLookup = dnsPromises.lookup;
dnsPromises.lookup = async (host, options) => (isLocal(host) ? realPromiseLookup(host, options) : Promise.reject(offline(host)));
dns.lookup = (host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  if (isLocal(host)) return realLookup(host, options, callback);
  process.nextTick(cb, offline(host));
};

// Read by lib/env.ts at import time, so it must be set before requiring.
process.env.DATA_DIR = dataDir;
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
process.env.CREDENTIALS_SECRET = randomBytes(48).toString("base64");
process.env.ANALYSIS_DEMO_FALLBACK = "true"; // no live crawl in a test run
process.env.PAYMENTS_MODE = "mock";
process.env.NODE_ENV = "development";

// Gateway credentials must come from the database in this run, so the
// environment fallback is cleared: it would otherwise mask a bug where the
// admin panel's stored credentials are not being read.
for (const name of [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "CASHFREE_APP_ID",
  "CASHFREE_SECRET_KEY",
  "CASHFREE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  // The bootstrap admin would add an account the counts below do not expect.
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
]) {
  delete process.env[name];
}

function compileLib() {
  const tsconfig = path.join(workDir, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "commonjs",
        moduleResolution: "node",
        esModuleInterop: true,
        skipLibCheck: true,
        strict: true,
        outDir,
        rootDir: projectRoot,
        baseUrl: projectRoot,
        paths: { "@/*": ["./*"] },
        types: ["node"],
        // The generated config sits in a temp directory, so @types has to
        // be pointed at explicitly rather than found by walking upwards.
        typeRoots: [path.join(projectRoot, "node_modules", "@types")],
      },
      include: [path.join(projectRoot, "lib/**/*.ts")],
    }),
  );

  const tsc = path.join(projectRoot, "node_modules", ".bin", "tsc");
  execFileSync(tsc, ["-p", tsconfig], { stdio: "inherit" });

  // The emitted JS keeps the "@/lib/..." specifiers, so give Node a
  // package directory literally named "@" that points at the output.
  const nodeModules = path.join(outDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(outDir, path.join(nodeModules, "@"), "dir");
  // Third-party packages lib/ imports at runtime, resolved from the project.
  for (const pkg of ["libphonenumber-js", "sharp", "nodemailer", "cheerio"]) {
    const source = path.join(projectRoot, "node_modules", pkg);
    try {
      symlinkSync(source, path.join(nodeModules, pkg), "dir");
    } catch {
      /* not installed: only the modules that need it would fail */
    }
  }
}

let passed = 0;
const failures = [];

/** @param {string} label @param {unknown} got @param {unknown} want */
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(
      `  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`,
    );
  }
}

/** @param {string} name */
function group(name) {
  console.log(`\n${name}`);
}

const DAY_MS = 86_400_000;

async function main() {
  console.log(`Compiling lib/ → ${outDir}`);
  compileLib();

  const require_ = createRequire(import.meta.url);
  /** @param {string} p */
  const load = (p) => require_(path.join(outDir, p));

  const { one, run } = load("lib/db/index.js");
  const accounts = load("lib/db/accounts.js");
  const admin = load("lib/db/admin.js");
  const audits = load("lib/db/audits.js");
  const billing = load("lib/db/billing.js");
  const catalogue = load("lib/plan-catalogue.js");
  const entitlement = load("lib/entitlement.js");
  const fulfil = load("lib/billing/fulfil.js");
  const gateways = load("lib/payments/config.js");
  const net = load("lib/analysis/net.js");
  const passwords = load("lib/auth/password.js");
  const payments = load("lib/payments/index.js");
  const service = load("lib/audit-service.js");
  const shipped = load("lib/plans.js");
  const target = load("lib/analysis/target.js");
  const validate = load("lib/validate.js");

  /* ── the catalogue ─────────────────────────────────────────────── */

  group("the plan catalogue is the single source of truth");
  const plans = catalogue.listPlans();
  check("exactly three plans", plans.map((p) => p.id), ["free", "basic", "pro"]);
  check("every plan is billed monthly", plans.every((p) => p.interval === "month"), true);
  check(
    "no plan carries a lifetime or one-off price",
    plans.every((p) => p.interval === "month" && p.amountPaise >= 0),
    true,
  );

  const free = catalogue.requirePlan("free");
  const basicPlan = catalogue.requirePlan("basic");
  const proPlan = catalogue.requirePlan("pro");

  check("prices are ₹0 / ₹399 / ₹999", [free.amountPaise, basicPlan.amountPaise, proPlan.amountPaise], [0, 39900, 99900]);
  check("monthly scan allowances are 10 / 100 / 300", [free.scanLimit, basicPlan.scanLimit, proPlan.scanLimit], [10, 100, 300]);
  check("website allowances are 1 / 3 / 8", [free.siteLimit, basicPlan.siteLimit, proPlan.siteLimit], [1, 3, 8]);
  check("Free is granted, never sold", free.purchasable, false);
  check("only Basic and Pro are purchasable", catalogue.listPurchasablePlans().map((p) => p.id), ["basic", "pro"]);
  check("Free has no AI content check", free.features.includes("ai_content_check"), false);
  check("Basic includes the AI content check", basicPlan.features.includes("ai_content_check"), true);
  check("Basic includes originality and duplicate checks", [basicPlan.features.includes("originality_check"), basicPlan.features.includes("duplicate_content_check")], [true, true]);
  check("PDF export is Pro only", [free.features.includes("pdf_export"), basicPlan.features.includes("pdf_export"), proPlan.features.includes("pdf_export")], [false, false, true]);
  check("Pro includes every feature Basic has", basicPlan.features.every((f) => proPlan.features.includes(f)), true);
  check("cheapest plan with AI checking is Basic", catalogue.cheapestPlanWith("ai_content_check")?.id, "basic");
  check("cheapest plan with PDF export is Pro", catalogue.cheapestPlanWith("pdf_export")?.id, "pro");
  check(
    "the shipped defaults seeded the table unchanged",
    [free.scanLimit, basicPlan.scanLimit, proPlan.scanLimit],
    [shipped.PLANS.free.scanLimit, shipped.PLANS.basic.scanLimit, shipped.PLANS.pro.scanLimit],
  );

  // The number quoted on the pricing page has to be the number the engine
  // would actually run, or the copy is a promise nothing keeps.
  const checks = load("lib/analysis/checks.js");
  const counts = [free, basicPlan, proPlan].map((plan) => checks.checkCountFor(plan.features));
  console.log(`  ·     checks per scan: ${counts[0]} free / ${counts[1]} basic / ${counts[2]} pro of ${checks.TOTAL_CHECKS}`);
  check("each tier runs strictly more checks than the one below", counts[0] < counts[1] && counts[1] < counts[2], true);
  check("Pro runs the whole catalogue", counts[2], checks.TOTAL_CHECKS);
  check("every check belongs to a feature some plan sells", counts[2] > 0 && counts[0] > 0, true);

  /* ── signup, passwords, accounts, sessions ─────────────────────── */

  group("signup validation");
  check("empty name rejected", typeof validate.validateName("") === "string", true);
  check("real name accepted", validate.validateName("Sandeep Raj"), null);
  check("malformed email rejected", typeof validate.validateEmail("nope@") === "string", true);
  check("valid email accepted", validate.validateEmail("a@b.co"), null);
  check("short password rejected", typeof validate.validatePassword("abc") === "string", true);
  check("long but weak password rejected", typeof validate.validatePassword("aaaaaaaaaaaa") === "string", true);
  check("strong password accepted", validate.validatePassword("Str0ng-Passw0rd!"), null);
  check("mismatched confirmation rejected", typeof validate.validateConfirmPassword("Str0ng-Passw0rd!", "other") === "string", true);

  group("password storage");
  const hash = await passwords.hashPassword("Str0ng-Passw0rd!");
  check("plaintext never appears in the stored value", hash.includes("Str0ng-Passw0rd!"), false);
  check("stored value names its algorithm", hash.startsWith("scrypt$"), true);
  check("correct password verifies", await passwords.verifyPassword("Str0ng-Passw0rd!", hash), true);
  check("wrong password rejected", await passwords.verifyPassword("Str0ng-Passw0rd?", hash), false);
  check("garbage hash rejected without throwing", await passwords.verifyPassword("x", "not-a-hash"), false);

  const stamp = Date.now().toString(36);
  /** @param {string} label */
  const makeUser = (label) =>
    accounts.createUser({
      name: `Verify ${label}`,
      email: `verify-${label}-${stamp}@example.test`,
      passwordHash: hash,
    });

  group("accounts");
  const user = makeUser("free");
  check("account created", typeof user.id === "string" && user.id.length > 3, true);
  check("email normalised to lowercase", user.email, `verify-free-${stamp}@example.test`);
  check("a new account is not an admin", user.role, "user");
  let duplicateRejected = false;
  try {
    accounts.createUser({ name: "Impostor", email: user.email.toUpperCase(), passwordHash: hash });
  } catch {
    duplicateRejected = true;
  }
  check("duplicate email refused, case-insensitively", duplicateRejected, true);
  check("login lookup is case-insensitive", accounts.findUserRowByEmail(user.email.toUpperCase())?.id, user.id);
  check("unknown email returns null", accounts.findUserRowByEmail("nobody@example.test"), null);

  group("sessions");
  const token = randomBytes(32).toString("base64url");
  const sessionId = createHash("sha256").update(token).digest("hex");
  const expiresAt = Date.now() + 30 * DAY_MS;
  accounts.createSession({ id: sessionId, userId: user.id, expiresAt, userAgent: "verify", ip: null });
  check("session resolves to its user", accounts.findSessionUser(sessionId)?.user.id, user.id);
  check("the cookie token itself is not stored", one("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", [token]).n, 0);
  check("expired session does not resolve", accounts.findSessionUser(sessionId, expiresAt + 1), null);
  for (let i = 0; i < 2; i++) {
    accounts.createSession({
      id: createHash("sha256").update(randomBytes(32)).digest("hex"),
      userId: user.id,
      expiresAt,
    });
  }
  check("all sessions counted", accounts.countSessions(user.id), 3);
  accounts.deleteOtherSessions(user.id, sessionId);
  check("password change revokes every other session", accounts.countSessions(user.id), 1);
  check("the current session survives", accounts.findSessionUser(sessionId)?.user.id, user.id);

  /* ── the address filter ────────────────────────────────────────── */

  group("addresses a customer may legitimately submit");
  for (const input of [
    "example.com",
    "www.example.com",
    "https://example.com",
    "http://example.com",
    "https://www.example.com/blog/post?utm_source=x",
    "EXAMPLE.COM",
    "example.com.",
    "  example.com  ",
    "example.com:8080",
    "deep.sub.example.com",
  ]) {
    const parsed = target.parseTarget(input);
    check(`accepted: ${input.trim()}`, parsed.ok, true);
  }
  check("a bare domain is normalised to https", target.parseTarget("example.com").target.url.protocol, "https:");
  check("http:// is preserved when it was typed", target.parseTarget("http://example.com").target.url.protocol, "http:");
  check("www is stripped for grouping", target.parseTarget("https://www.example.com/x").target.domain, "example.com");
  check("a subdomain is its own site", target.parseTarget("blog.example.com").target.domain, "blog.example.com");
  check("apex and www are both tried", target.hostAlternatives("example.com"), ["example.com", "www.example.com"]);

  group("addresses that are refused before anything is charged for");
  for (const [input, reason] of [
    ["", "empty"],
    ["not a url", "shape"],
    ["ftp://example.com", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["http://user:pass@example.com", "credentials"],
    ["example.com:22", "port"],
    ["127.0.0.1", "ip_literal"],
    ["169.254.169.254", "ip_literal"],
    ["10.0.0.1", "ip_literal"],
    ["[::1]", "ip_literal"],
  ]) {
    const parsed = target.parseTarget(input);
    check(`refused (${reason}): ${input || "(empty)"}`, parsed.ok === false && parsed.reason, reason);
  }

  group("hostnames that must never be dialled");
  for (const host of [
    "localhost",
    "metadata.internal",
    "printer.local",
    "db.intranet",
    "files.private",
    "wiki.corp",
    "nas.home",
    "router.lan",
    "host.home.arpa",
    "1.0.0.127.in-addr.arpa",
    "anything.test",
    "nope.invalid",
    "hidden.onion",
  ]) {
    check(`blocked hostname: ${host}`, net.isBlockedHostname(host), true);
  }
  for (const host of ["example.com", "example.net", "example.org", "google.com", "my-blog.co.in", "www.wikipedia.org"]) {
    check(`allowed hostname: ${host}`, net.isBlockedHostname(host), false);
  }

  group("addresses the resolver must not be followed to");
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.4.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "2002:7f00:0001::",
  ]) {
    check(`blocked address: ${ip}`, net.isBlockedAddress(ip), true);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    check(`public address allowed: ${ip}`, net.isBlockedAddress(ip), false);
  }
  check("an IP literal is recognised as one", [net.isIpLiteral("8.8.8.8"), net.isIpLiteral("::1"), net.isIpLiteral("example.com")], [true, true, false]);

  /* ── auditing with no plan ─────────────────────────────────────── */

  group("auditing without a plan");
  const noPlan = await service.startAudit(user, "example.com", { wait: true });
  check("no plan is refused", noPlan.code, "NO_ACTIVE_PLAN");
  check("the refusal quotes the free allowance from the catalogue", noPlan.message.includes(`${free.scanLimit} scans a month`), true);
  check("an unusable URL is refused before entitlement", (await service.startAudit(user, "not a url", { wait: true })).code, "INVALID_URL");
  check("a private address is refused as a refusal, not a typo", (await service.startAudit(user, "127.0.0.1", { wait: true })).code, "URL_NOT_ALLOWED");
  check("nothing was recorded for any of that", audits.listReports(user.id).length, 0);

  /* ── the free tier ─────────────────────────────────────────────── */

  group("the free tier as granted at signup");
  billing.createSubscription({ userId: user.id, plan: free, paymentStatus: "free", amountPaise: 0 });
  const freeSub = billing.getActiveSubscription(user.id);
  check("subscription is active", freeSub.status, "active");
  check("no money is claimed for it", [freeSub.amountPaise, freeSub.paymentStatus], [0, "free"]);
  check("ten scans this month", [freeSub.scansUsed, freeSub.scanLimit, freeSub.scansRemaining], [0, 10, 10]);
  check("usage reads as 0 / 10", entitlement.usageLabel(freeSub), "0 / 10");
  check("one website", freeSub.siteLimit, 1);
  check("first month of the cycle", freeSub.cycleIndex, 1);
  // Calendar months since Phase 4: a month is 28–31 days.
  check("the allowance resets inside a month", freeSub.daysUntilReset <= 31, true);
  check("nothing blocks it", entitlement.entitlementBlock(freeSub), null);

  group("a blocked host costs the customer nothing");
  const refusedHost = await service.startAudit(user, "metadata.internal", { wait: true });
  check("an internal hostname is refused", refusedHost.code, "URL_NOT_ALLOWED");
  check("no scan was spent", billing.getActiveSubscription(user.id).scansUsed, 0);
  check("no website row was created", audits.listWebsites(user.id).length, 0);
  check("no report row was created", audits.listReports(user.id).length, 0);

  group("a free scan");
  const firstRun = await service.startAudit(user, "https://example.com/some/path?x=1", { wait: true });
  check("scan accepted", firstRun.ok, true);
  if (!firstRun.ok) throw new Error(`scan failed: ${firstRun.code} ${firstRun.message}`);
  const report = firstRun.report;
  check("URL reduced to its domain", report.domain, "example.com");
  check("report completed", report.state, "complete");
  check("score within 0–100", report.score >= 0 && report.score <= 100, true);
  check("verdict is one of the three", ["ready", "needs_improvement", "not_ready"].includes(report.verdict), true);
  check("only the categories that ran are scored", report.categories.length > 0 && report.categories.length <= 6, true);
  check("category weights are rebased to the checks that ran", Math.abs(report.categories.reduce((sum, c) => sum + c.weight, 0) - 100) <= 1, true);
  check("findings stored", audits.listIssues(report.id).length > 0, true);
  check("every check is accounted for", report.passedCount + report.warningCount + report.criticalCount, report.checksRun);
  check("an offline run is labelled demo", report.analysisMode, "demo");
  check("a demo run claims no fetched pages", report.pagesFetched, 0);
  check("one scan consumed", billing.getActiveSubscription(user.id).scansUsed, 1);
  check("the report records the plan it ran on", report.planId, "free");
  check("only the free features ran", report.features, free.features);

  group("a locked feature produces no result at all");
  check("AI likelihood was not measured", "aiLikelihood" in report.metrics, false);
  check("originality was not measured", "originality" in report.metrics, false);
  check("ad density was not measured", "adDensity" in report.metrics, false);
  check("no page-by-page table", report.pages.length, 0);
  check("no policy risk list", report.metrics.risks ?? [], []);
  check("no AI recommendations", report.metrics.recommendations ?? [], []);
  check("the paid checks are named as not run", report.locked.includes("ai_content_check"), true);
  check("what was locked is disjoint from what ran", report.locked.some((f) => report.features.includes(f)), false);

  group("the upgrade prompt names a real plan");
  const siteCurrency = load("lib/site-currency.js");
  check("with no USD price set, the default USD site quotes no price", entitlement.featureBlock(freeSub, "ai_content_check").message.includes("/month"), false);
  siteCurrency.setSiteCurrency("INR", "verify");
  const aiBlock = entitlement.featureBlock(freeSub, "ai_content_check");
  check("AI checking is locked on Free", aiBlock.code, "FEATURE_LOCKED");
  check("it points at Basic", aiBlock.message.includes("Basic"), true);
  check("it quotes the monthly price in the site currency", aiBlock.message.includes("₹399/month"), true);
  check("and offers the upgrade", aiBlock.action.href, "/pricing");
  check("PDF export points at Pro", entitlement.featureBlock(freeSub, "pdf_export").message.includes("Pro"), true);
  check("HTTPS checking is not locked", entitlement.featureBlock(freeSub, "https_check"), null);

  group("the free site and scan limits bite");
  check("a second website is refused", (await service.startAudit(user, "example.org", { wait: true })).code, "SITE_LIMIT_REACHED");
  check("re-scanning the site we know is allowed", (await service.startAudit(user, "www.example.com", { wait: true })).ok, true);
  check("the website row was reused", audits.listWebsites(user.id).length, 1);
  check("two scans consumed", billing.getActiveSubscription(user.id).scansUsed, 2);

  run("UPDATE subscriptions SET scans_used = scan_limit WHERE id = ?", [freeSub.id]);
  const capped = billing.getActiveSubscription(user.id);
  check("the month's allowance is spent", capped.isCapped, true);
  check("the plan itself is still fine", capped.status, "active");
  check("the wording is the monthly one", /^Monthly scan limit reached\. You've used all \d+ scans? on the .+ plan this month; your allowance resets on .+\. Upgrade your plan to scan again sooner\.$/.test(entitlement.entitlementBlock(capped).message), true);
  check("a scan is refused", (await service.startAudit(user, "example.com", { wait: true })).code, "LIMIT_REACHED");
  check("usage reads as 10 / 10", entitlement.usageLabel(capped), "10 / 10");

  group("report ownership");
  const stranger = makeUser("stranger");
  check("another account cannot read the report", audits.findReportForUser(report.id, stranger.id), null);
  check("the owner can read it", audits.findReportForUser(report.id, user.id)?.id, report.id);
  check("another account cannot delete it", audits.deleteReportForUser(report.id, stranger.id), false);
  check("the owner can delete", audits.deleteReportForUser(report.id, user.id), true);
  check("findings are removed with the report", audits.listIssues(report.id).length, 0);
  check("deleting does not refund the scan", billing.getActiveSubscription(user.id).scansUsed, 10);

  /* ── monthly cycles ───────────────────────────────────────────── */

  group("the monthly cycle refills the allowance");
  const cycleUser = makeUser("cycle");
  const adminActor = { id: "verify-admin", email: `admin-${stamp}@example.test` };
  // A three-month comp, so the subscription outlives the first cycle and
  // the roll is observable. A one-month subscription expires at its own
  // cycle end by design and is renewed by a new payment instead.
  const cycleSub = billing.assignPlan({
    userId: cycleUser.id,
    plan: basicPlan,
    note: "verify: three-month comp",
    months: 3,
  });
  check("granted without a payment", cycleSub.amountPaise, 0);
  check("the note records why", cycleSub.adminNote, "verify: three-month comp");
  check("a hundred scans this month", cycleSub.scanLimit, 100);
  // Calendar months since Phase 4 (lib/billing/cycle.ts), counted from the start.
  const calendar = load("lib/billing/cycle.js");
  check("the cycle is a month, the subscription is three", [cycleSub.cycleEnd, cycleSub.expiresAt], [calendar.addCalendarMonths(cycleSub.startsAt, 1), calendar.addCalendarMonths(cycleSub.startsAt, 3)]);

  for (let i = 0; i < 40; i++) billing.consumeScan(cycleSub.id);
  check("forty scans spent", billing.findSubscription(cycleSub.id).scansUsed, 40);

  // An admin raises the allowance mid-cycle. The live subscription keeps
  // the terms it was granted under until the cycle turns over.
  const raised = catalogue.updatePlan("basic", { scanLimit: 120 }, adminActor);
  check("the catalogue accepted the change", raised.ok && raised.changed.length > 0, true);
  check("the live subscription is untouched mid-cycle", billing.findSubscription(cycleSub.id).scanLimit, 100);

  run("UPDATE subscriptions SET cycle_start = ?, cycle_end = ? WHERE id = ?", [Date.now() - 31 * DAY_MS, Date.now() - 1_000, cycleSub.id]);
  check("one subscription rolled", billing.rollBillingCycles(), 1);
  const rolled = billing.findSubscription(cycleSub.id);
  check("the allowance is back to zero used", rolled.scansUsed, 0);
  check("the cycle counter advanced", rolled.cycleIndex, 2);
  check("the new limit landed at the roll", rolled.scanLimit, 120);
  check("the next reset is in the future", rolled.cycleEnd > Date.now(), true);
  check("the subscription is still active", rolled.status, "active");

  const restored = catalogue.resetPlan("basic", adminActor);
  check("the plan was restored", restored.ok && catalogue.requirePlan("basic").scanLimit, 100);
  check("rolling again does nothing until the cycle ends", billing.rollBillingCycles(), 0);

  group("an expired subscription stops working");
  const expiredUser = makeUser("expired");
  const expiredSub = billing.createSubscription({ userId: expiredUser.id, plan: basicPlan, paymentStatus: "paid" });
  run("UPDATE subscriptions SET expires_at = ? WHERE id = ?", [Date.now() - 1_000, expiredSub.id]);
  const expiredRow = accounts.findUserById(expiredUser.id);
  check("a scan is refused", (await service.startAudit(expiredRow, "example.com", { wait: true })).code, "NO_ACTIVE_PLAN");
  check("the sweep marked it expired", billing.getLatestSubscription(expiredUser.id).status, "expired");
  check("no active subscription remains", billing.getActiveSubscription(expiredUser.id), null);
  check("the dashboard explains the expiry", entitlement.entitlementBlock(billing.getLatestSubscription(expiredUser.id)).code, "PLAN_EXPIRED");
  check("the expiry wording offers a renewal", entitlement.entitlementBlock(billing.getLatestSubscription(expiredUser.id)).action.href, "/pricing");

  /* ── checkout ─────────────────────────────────────────────────── */

  group("what checkout may offer");
  const options = payments.checkoutOptions();
  check("all three gateways are present", options.map((o) => o.id), ["razorpay", "cashfree", "paypal"]);
  check("in mock mode every one is a simulator", options.every((o) => o.simulated), true);
  check("checkout is possible", payments.checkoutIsPossible(), true);
  check("no gateway secret is anywhere in the offer", JSON.stringify(options).includes("secret"), false);

  group("the gateway return lands on the host holding the cookie");
  // The session cookie is host-only. With NEXT_PUBLIC_APP_URL unset the
  // old default sent everyone to http://localhost:3000, so a customer on
  // 127.0.0.1 or port 3001 came back from Cashfree/PayPal logged out.
  const localReturn = payments.checkoutReturnUrl(
    new Request("http://127.0.0.1:3001/api/checkout/order", { headers: { host: "127.0.0.1:3001" } }),
  );
  check("unconfigured dev: return uses the request's own origin", localReturn, "http://127.0.0.1:3001/dashboard/billing/return");
  const pick = (configured, production) =>
    payments.returnOrigin({ configured, production, appUrl: "https://checker.example", requestOrigin: "http://evil.example" });
  check("a configured app URL always wins over the Host header", pick(true, false), "https://checker.example");
  check("production never trusts the Host header", [pick(false, true), pick(true, true)], ["https://checker.example", "https://checker.example"]);

  const buyer = makeUser("buyer");
  const buyerRow = accounts.findUserById(buyer.id);

  group("buying Basic");
  check(
    "the free plan cannot be bought",
    (await payments.startCheckout({ userId: buyer.id, plan: free, gateway: "razorpay", customerName: buyer.name, customerEmail: buyer.email })).code,
    "VALIDATION_ERROR",
  );

  const started = await payments.startCheckout({
    userId: buyer.id,
    plan: basicPlan,
    gateway: "razorpay",
    customerName: buyer.name,
    customerEmail: buyer.email,
  });
  check("checkout opened", started.ok, true);
  if (!started.ok) throw new Error(`checkout failed: ${started.code} ${started.message}`);
  check("it is marked simulated", started.simulated, true);
  check("the order is a mock order", started.orderId.startsWith("order_mock_"), true);
  check("priced from the plan, not the browser", started.amountPaise, 39900);
  check("the payment row starts unpaid", billing.findPaymentByOrderId(started.orderId).status, "created");
  check("and is stamped mock so it can never settle as real", billing.findPaymentByOrderId(started.orderId).mode, "mock");
  check("no plan is granted before payment", billing.getActiveSubscription(buyer.id), null);

  check(
    "another account cannot settle this order",
    (await payments.verifyCheckout({ userId: stranger.id, orderId: started.orderId, payload: {} })).code,
    "FORBIDDEN",
  );
  check(
    "an unknown order settles nothing",
    (await payments.verifyCheckout({ userId: buyer.id, orderId: "order_nope", payload: {} })).code,
    "ORDER_NOT_FOUND",
  );

  const settled = await payments.verifyCheckout({ userId: buyer.id, orderId: started.orderId, payload: {} });
  check("the order settled", settled.ok && settled.status, "fulfilled");
  check("an invoice was issued", typeof settled.invoiceId === "string" && settled.invoiceId.length > 3, true);

  const basicSub = billing.getActiveSubscription(buyer.id);
  check("Basic is active", [basicSub.planId, basicSub.status, basicSub.paymentStatus], ["basic", "active", "paid"]);
  check("a hundred scans this month", [basicSub.scansUsed, basicSub.scanLimit], [0, 100]);
  check("three websites", basicSub.siteLimit, 3);
  check("the price paid is recorded", basicSub.amountPaise, 39900);
  check("the gateway is recorded", basicSub.gateway, "razorpay");
  check("the invoice is linked", basicSub.invoiceId, settled.invoiceId);
  const invoice = billing.findInvoice(settled.invoiceId);
  check("the invoice belongs to the buyer", invoice.userId, buyer.id);
  check("the invoice total is the plan price", invoice.amountPaise, 39900);
  check("the payment is marked paid", billing.findPaymentByOrderId(started.orderId).status, "paid");

  group("settling the same order twice");
  const replay = await payments.verifyCheckout({ userId: buyer.id, orderId: started.orderId, payload: {} });
  check("the second attempt is idempotent", replay.ok && replay.status, "already");
  check("it returns the same subscription", replay.subscriptionId, basicSub.id);
  check("no second subscription", billing.listSubscriptions(buyer.id).length, 1);
  check("no second payment row", billing.listPayments(buyer.id).length, 1);
  check("no second invoice", billing.listInvoices(buyer.id).length, 1);

  group("cross-checks that stop a forged payment");
  const forgedOrder = `order_verify_forged_${stamp}`;
  billing.createPayment({
    userId: buyer.id,
    planId: "pro",
    amountPaise: proPlan.amountPaise,
    currency: proPlan.currency,
    orderId: forgedOrder,
    gateway: "razorpay",
    environment: "sandbox",
    mode: "live",
    receipt: "rcpt_verify_forged",
  });
  check(
    "underpayment grants nothing",
    fulfil.fulfilPayment({ orderId: forgedOrder, gatewayPaymentId: "pay_x", observedAmountPaise: 100, observedCurrency: "INR" }).status,
    "mismatch",
  );
  check(
    "the wrong currency grants nothing",
    fulfil.fulfilPayment({ orderId: forgedOrder, gatewayPaymentId: "pay_x", observedAmountPaise: proPlan.amountPaise, observedCurrency: "USD" }).status,
    "mismatch",
  );
  check("an unknown order grants nothing", fulfil.fulfilPayment({ orderId: "order_absent", gatewayPaymentId: "pay_x" }).status, "not_found");
  check("still only one subscription", billing.listSubscriptions(buyer.id).length, 1);

  billing.markPaymentFailed(forgedOrder, "Customer abandoned the page.", "cancelled");
  check("a cancelled order cannot be revived", fulfil.fulfilPayment({ orderId: forgedOrder, gatewayPaymentId: "pay_x", observedAmountPaise: proPlan.amountPaise, observedCurrency: "INR" }).status, "closed");
  billing.markPaymentFailed(started.orderId, "Late failure notice.");
  check("a settled payment cannot be marked failed afterwards", billing.findPaymentByOrderId(started.orderId).status, "paid");

  /* ── paid features ────────────────────────────────────────────── */

  group("what Basic actually unlocks");
  check("AI content check is available", entitlement.hasFeature(basicSub, "ai_content_check"), true);
  check("originality is available", entitlement.hasFeature(basicSub, "originality_check"), true);
  check("PDF export is not", entitlement.hasFeature(basicSub, "pdf_export"), false);
  check("page-by-page is not", entitlement.hasFeature(basicSub, "page_by_page_analysis"), false);

  const basicRun = await service.startAudit(buyerRow, "example.com", { wait: true });
  check("a Basic scan runs", basicRun.ok, true);
  if (!basicRun.ok) throw new Error(`basic scan failed: ${basicRun.code} ${basicRun.message}`);
  check("AI likelihood is measured", typeof basicRun.report.metrics.aiLikelihood, "number");
  check("it is reported as a band, not a verdict", ["low", "moderate", "elevated"].includes(basicRun.report.metrics.aiBand), true);
  check("originality is measured", typeof basicRun.report.metrics.originality, "number");
  check("ad density is still locked", "adDensity" in basicRun.report.metrics, false);
  check("Basic runs more checks than Free", basicRun.report.checksRun > report.checksRun, true);
  check("the deeper Pro checks are named as missing", basicRun.report.locked.includes("deep_ai_page_check"), true);
  check("nothing is sold twice in the locked list", basicRun.report.locked.some((f) => basicRun.report.features.includes(f)), false);

  group("a feature added to a plan lands immediately; one removed does not claw back");
  catalogue.updatePlan("basic", { features: [...basicPlan.features, "pdf_export"] }, adminActor);
  check("adding PDF export to Basic reaches a live subscription", entitlement.hasFeature(billing.getActiveSubscription(buyer.id), "pdf_export"), true);
  catalogue.resetPlan("basic", adminActor);
  check("removing it again takes it back", entitlement.hasFeature(billing.getActiveSubscription(buyer.id), "pdf_export"), false);

  const proUser = makeUser("pro");
  const proSub = billing.assignPlan({ userId: proUser.id, plan: proPlan, note: "verify: pro comp" });
  check("Pro was sold PDF export", proSub.features.includes("pdf_export"), true);
  catalogue.updatePlan("pro", { features: proPlan.features.filter((f) => f !== "pdf_export") }, adminActor);
  check("removing it from the plan does not remove it from a paid month", entitlement.hasFeature(billing.getActiveSubscription(proUser.id), "pdf_export"), true);
  check("a subscription created now would not include it", catalogue.requirePlan("pro").features.includes("pdf_export"), false);
  catalogue.resetPlan("pro", adminActor);
  check("the plan was restored", catalogue.requirePlan("pro").features.includes("pdf_export"), true);

  group("a Pro scan measures what Pro sells");
  const proRun = await service.startAudit(accounts.findUserById(proUser.id), "example.org", { wait: true });
  check("the scan runs", proRun.ok, true);
  if (!proRun.ok) throw new Error(`pro scan failed: ${proRun.code} ${proRun.message}`);
  const proReport = proRun.report;
  check("nothing is locked on Pro", proReport.locked, []);
  check("pages are scored individually", proReport.pages.length > 0, true);
  check("a remediation list is produced", Array.isArray(proReport.metrics.recommendations), true);
  check("policy risk is banded, not asserted", ["low", "moderate", "elevated", "high"].includes(proReport.metrics.riskLevel), true);
  check("structure is measured", typeof proReport.metrics.maxDepth, "number");
  check("ad density is measured", typeof proReport.metrics.adDensity, "number");
  check("the sitemap is counted", typeof proReport.metrics.sitemapUrls, "number");
  check("human-signal scoring ran", typeof proReport.metrics.humanSignalScore, "number");
  check("Pro runs the most checks", proReport.checksRun >= basicRun.report.checksRun, true);
  check("Pro scores more of the six categories than Free", proReport.categories.length > report.categories.length, true);
  check("the report is exportable", proReport.features.includes("pdf_export"), true);
  check("three hundred scans a month, one spent", [billing.getActiveSubscription(proUser.id).scansUsed, billing.getActiveSubscription(proUser.id).scanLimit], [1, 300]);

  group("failed attempts do not pile up in the history");
  const proSite = audits.listWebsites(proUser.id)[0];
  for (let i = 0; i < 2; i++) {
    const stale = audits.createRunningReport({
      userId: proUser.id,
      websiteId: proSite.id,
      subscriptionId: proSub.id,
      url: "https://example.org/",
      domain: "example.org",
      planId: proSub.planId,
      planName: proSub.planName,
      engineVersion: "verify",
      analysisMode: "live",
      features: proSub.features,
    });
    audits.failReport(stale.id, "Verification run.");
  }
  check("three rows for the site", one("SELECT COUNT(*) AS n FROM reports WHERE website_id = ?", [proSite.id]).n, 3);
  check("a fresh scan is accepted", (await service.startAudit(accounts.findUserById(proUser.id), "example.org", { wait: true })).ok, true);
  check("the failed rows were cleared, leaving the real ones", one("SELECT COUNT(*) AS n FROM reports WHERE website_id = ?", [proSite.id]).n, 2);
  check("no failed rows remain", one("SELECT COUNT(*) AS n FROM reports WHERE website_id = ? AND state = 'failed'", [proSite.id]).n, 0);

  /* ── admin ───────────────────────────────────────────────────── */

  group("suspending an account");
  accounts.createSession({ id: createHash("sha256").update(randomBytes(32)).digest("hex"), userId: cycleUser.id, expiresAt });
  check("the account has a session", accounts.countSessions(cycleUser.id), 1);
  check("blocking it succeeds", accounts.blockUser(cycleUser.id, "Chargeback under review."), true);
  check("every session is revoked", accounts.countSessions(cycleUser.id), 0);
  const blockedRow = accounts.findUserById(cycleUser.id);
  check("the row records the suspension", blockedRow.isBlocked, true);
  const blockedAttempt = await service.startAudit(blockedRow, "example.com", { wait: true });
  check("a scan is refused", blockedAttempt.code, "ACCOUNT_BLOCKED");
  check("the reason is quoted back", blockedAttempt.message.includes("Chargeback under review."), true);
  check("the same wording is what the dashboard shows", entitlement.accountBlock(blockedRow).code, "ACCOUNT_BLOCKED");
  check("their subscription is not destroyed", billing.getActiveSubscription(cycleUser.id).planId, "basic");
  check("unblocking succeeds", accounts.unblockUser(cycleUser.id), true);
  check("service resumes", (await service.startAudit(accounts.findUserById(cycleUser.id), "example.com", { wait: true })).ok, true);
  check("no suspension remains", entitlement.accountBlock(accounts.findUserById(cycleUser.id)), null);

  group("re-pricing a plan does not rewrite billing history");
  const priceChange = catalogue.updatePlan("pro", { amountPaise: 129900 }, adminActor);
  check("the change was applied", priceChange.ok && catalogue.requirePlan("pro").amountPaise, 129900);
  check("it is described for the log", priceChange.changed.some((note) => note.includes("₹1,299")), true);
  check("the paid invoice still says ₹399", billing.findInvoice(settled.invoiceId).amountPaise, 39900);
  check("the live Basic subscription still says ₹399", billing.getActiveSubscription(buyer.id).amountPaise, 39900);
  check("the Free plan cannot be given a price", catalogue.updatePlan("free", { amountPaise: 100 }, adminActor).error, "The Free plan must stay at ₹0.");
  check("a scan limit below one is refused", catalogue.updatePlan("pro", { scanLimit: 0 }, adminActor).ok, false);
  check("an absurd price is refused", catalogue.updatePlan("pro", { amountPaise: 99_999_999 }, adminActor).ok, false);
  catalogue.resetPlan("pro", adminActor);
  check("Pro is back to ₹999", catalogue.requirePlan("pro").amountPaise, 99900);

  group("the admin trail");
  admin.recordAdminAction({ admin: adminActor, action: "plan.price_changed", targetType: "plan", targetId: "pro", targetLabel: "Pro", detail: priceChange.changed.join("; ") });
  admin.recordAdminAction({ admin: adminActor, action: "user.blocked", targetType: "user", targetId: cycleUser.id, targetLabel: cycleUser.email, detail: "Chargeback under review." });
  admin.recordAdminAction({ admin: adminActor, action: "user.unblocked", targetType: "user", targetId: cycleUser.id, targetLabel: cycleUser.email, detail: null });
  const planLogs = admin.listAdminLogs({ targetId: "pro" });
  check("the price change is recorded", planLogs[0].action, "plan.price_changed");
  check("with the admin who made it", planLogs[0].adminEmail, adminActor.email);
  check("and what changed", planLogs[0].detail.includes("₹1,299"), true);
  const userLogs = admin.listAdminLogs({ targetId: cycleUser.id });
  check("both suspension events are recorded, newest first", userLogs.map((entry) => entry.action), ["user.unblocked", "user.blocked"]);
  check("the log is not empty", admin.countAdminLogs() >= 3, true);

  group("deleting an account leaves nothing behind");
  const doomed = makeUser("doomed");
  billing.createSubscription({ userId: doomed.id, plan: free, paymentStatus: "free", amountPaise: 0 });
  const doomedRun = await service.startAudit(accounts.findUserById(doomed.id), "example.net", { wait: true });
  check("they have a report", doomedRun.ok, true);
  const footprint = accounts.summariseUserFootprint(doomed.id);
  check("the footprint is counted before deleting", footprint.reports >= 1 && footprint.subscriptions >= 1, true);
  admin.recordAdminAction({ admin: adminActor, action: "user.deleted", targetType: "user", targetId: doomed.id, targetLabel: doomed.email, detail: "verify" });
  check("the account is deleted", accounts.deleteUser(doomed.id), true);
  check("no user row", accounts.findUserById(doomed.id), null);
  for (const table of ["sessions", "subscriptions", "payments", "invoices", "websites", "reports"]) {
    check(`no orphaned ${table}`, one(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [doomed.id]).n, 0);
  }
  check("no orphaned findings", one("SELECT COUNT(*) AS n FROM report_issues WHERE report_id NOT IN (SELECT id FROM reports)").n, 0);
  check("the audit entry outlives the account", admin.listAdminLogs({ targetId: doomed.id })[0].action, "user.deleted");

  /* ── gateway credentials ─────────────────────────────────────── */

  group("gateway credentials are encrypted at rest and masked on the way out");
  const keySecret = "rzp_secret_verify_0000000000001234";
  const webhookSecret = "whsec_verify_000000000000009876";
  const saved = gateways.saveGatewayCredentials({
    id: "razorpay",
    values: { keyId: "rzp_test_verify5678", keySecret, webhookSecret },
    enabled: true,
    environment: "sandbox",
    actorEmail: adminActor.email,
  });
  check("the credentials were accepted", saved.ok, true);
  if (!saved.ok) throw new Error(`saving credentials failed: ${saved.message}`);
  check("the gateway is enabled", saved.view.enabled, true);
  check("it reports itself configured", saved.view.configured, true);
  check("from the database, not the environment", saved.view.source, "database");
  check("the secret is masked to its last four", saved.view.masked.keySecret.endsWith("1234"), true);
  check("the mask is not the secret", saved.view.masked.keySecret.includes(keySecret), false);
  check("nothing in the view carries a full secret", JSON.stringify(saved.view).includes(keySecret), false);
  check("nor the webhook secret", JSON.stringify(saved.view).includes(webhookSecret), false);
  check("the change log names fields, not values", saved.changed.join(" ").includes(keySecret), false);

  const storedRow = gateways.gatewayRows().find((row) => row.id === "razorpay");
  check("the stored column is ciphertext", storedRow.credentials_cipher.includes(keySecret), false);
  check("and it is not empty", typeof storedRow.credentials_cipher === "string" && storedRow.credentials_cipher.length > 20, true);
  check("who saved it is recorded", storedRow.updated_by, adminActor.email);
  const liveConfig = gateways.gatewayConfig("razorpay");
  check("the server can still decrypt it", liveConfig.credentials.keySecret, keySecret);
  check("the webhook secret round-trips too", liveConfig.credentials.webhookSecret, webhookSecret);

  group("a gateway cannot be switched on half-configured");
  const halfOn = gateways.setGatewayEnabled("cashfree", true, adminActor.email);
  check("enabling an unconfigured gateway is refused", halfOn.ok, false);
  check("with a message that says what is missing", typeof halfOn.message === "string" && halfOn.message.length > 10, true);
  check("and it stays off", gateways.gatewayView("cashfree").enabled, false);
  check("only the configured one is enabled", gateways.enabledGatewayConfigs().map((c) => c.id), ["razorpay"]);
  check("PayPal has no credentials at all", gateways.gatewayView("paypal").source, "none");
  check("no masked view anywhere leaks a secret", JSON.stringify(gateways.gatewayViews()).includes(keySecret), false);
  check("an empty field does not clear a stored secret", gateways.saveGatewayCredentials({ id: "razorpay", values: { keySecret: "" }, actorEmail: adminActor.email }).ok, true);
  check("the secret survived the empty save", gateways.gatewayConfig("razorpay").credentials.keySecret, keySecret);

  /* ── webhooks ────────────────────────────────────────────────── */

  group("webhook deliveries that must be refused");
  check("an unknown gateway is a 404", (await payments.processWebhook("stripe", "{}", new Headers())).httpStatus, 404);
  const unconfigured = await payments.processWebhook("paypal", "{}", new Headers());
  check("an unconfigured gateway is acknowledged but not acted on", [unconfigured.httpStatus, unconfigured.outcome], [503, "ignored"]);

  /** @param {string} event @param {string} orderId @param {object} [opts] */
  const razorpayBody = (event, orderId, opts = {}) =>
    JSON.stringify({
      event,
      payload: {
        payment: {
          entity: {
            id: opts.paymentId ?? `pay_verify_${randomBytes(4).toString("hex")}`,
            order_id: orderId,
            amount: opts.amount ?? proPlan.amountPaise,
            currency: opts.currency ?? "INR",
            status: "captured",
            method: "upi",
            ...(opts.error ? { error_description: opts.error } : {}),
          },
        },
      },
    });

  /** @param {string} raw @param {string} eventId @param {string} [secret] */
  const razorpayHeaders = (raw, eventId, secret = webhookSecret) =>
    new Headers({
      "x-razorpay-signature": createHmac("sha256", secret).update(raw).digest("hex"),
      "x-razorpay-event-id": eventId,
    });

  const hookUser = makeUser("webhook");
  /** @param {string} suffix @param {string} planId @param {number} amount */
  const openOrder = (suffix, planId, amount) => {
    const orderId = `order_verify_${suffix}_${stamp}`;
    billing.createPayment({
      userId: hookUser.id,
      planId,
      amountPaise: amount,
      currency: "INR",
      orderId,
      gateway: "razorpay",
      environment: "sandbox",
      mode: "live",
      receipt: `rcpt_${suffix}`,
    });
    return orderId;
  };

  const hookOrder = openOrder("hook", "pro", proPlan.amountPaise);
  const unsigned = await payments.processWebhook("razorpay", razorpayBody("payment.captured", hookOrder), new Headers());
  check("an unsigned delivery is refused", [unsigned.httpStatus, unsigned.outcome], [400, "rejected"]);
  check("it granted nothing", billing.getActiveSubscription(hookUser.id), null);

  const tamperedBody = razorpayBody("payment.captured", hookOrder);
  const tampered = await payments.processWebhook("razorpay", tamperedBody, razorpayHeaders(tamperedBody, "evt_verify_tampered", "the-wrong-secret"));
  check("a bad signature is refused", [tampered.httpStatus, tampered.outcome], [400, "rejected"]);
  check("the payment row is untouched", billing.findPaymentByOrderId(hookOrder).status, "created");
  check("the rejection is recorded for the admin panel", one("SELECT COUNT(*) AS n FROM webhook_events WHERE outcome = 'rejected'").n >= 2, true);

  group("a signed webhook is the authoritative settlement");
  const capturedBody = razorpayBody("payment.captured", hookOrder, { paymentId: "pay_verify_hook" });
  const captured = await payments.processWebhook("razorpay", capturedBody, razorpayHeaders(capturedBody, "evt_verify_captured"));
  check("it is processed", [captured.httpStatus, captured.outcome], [200, "processed"]);
  const hookSub = billing.getActiveSubscription(hookUser.id);
  check("Pro is active", [hookSub.planId, hookSub.status, hookSub.paymentStatus], ["pro", "active", "paid"]);
  check("three hundred scans a month", hookSub.scanLimit, 300);
  check("the payment is paid", billing.findPaymentByOrderId(hookOrder).status, "paid");
  check("the gateway's payment id is stored", billing.findPaymentByOrderId(hookOrder).paymentId, "pay_verify_hook");
  check("an invoice was issued", billing.listInvoices(hookUser.id).length, 1);

  const redelivered = await payments.processWebhook("razorpay", capturedBody, razorpayHeaders(capturedBody, "evt_verify_captured"));
  check("a redelivery is recognised", [redelivered.httpStatus, redelivered.outcome], [200, "duplicate"]);
  check("no second subscription", billing.listSubscriptions(hookUser.id).length, 1);
  check("no second invoice", billing.listInvoices(hookUser.id).length, 1);

  const sameOrderNewEvent = await payments.processWebhook("razorpay", capturedBody, razorpayHeaders(capturedBody, "evt_verify_captured_again"));
  check("a second event for a settled order changes nothing", [sameOrderNewEvent.httpStatus, sameOrderNewEvent.outcome], [200, "processed"]);
  check("still one subscription", billing.listSubscriptions(hookUser.id).length, 1);

  group("webhooks about orders that are not ours");
  const strayBody = razorpayBody("payment.captured", "order_from_another_deployment");
  const stray = await payments.processWebhook("razorpay", strayBody, razorpayHeaders(strayBody, "evt_verify_stray"));
  check("acknowledged so retries stop, but recorded as ignored", [stray.httpStatus, stray.outcome], [200, "ignored"]);
  check("no subscription appeared from nowhere", billing.listSubscriptions(hookUser.id).length, 1);

  group("a failed payment webhook closes the order");
  const failOrder = openOrder("failed", "basic", basicPlan.amountPaise);
  const failBody = razorpayBody("payment.failed", failOrder, { error: "The card was declined." });
  const failed = await payments.processWebhook("razorpay", failBody, razorpayHeaders(failBody, "evt_verify_failed"));
  check("it is processed", [failed.httpStatus, failed.outcome], [200, "processed"]);
  const failedRow = billing.findPaymentByOrderId(failOrder);
  check("the payment is marked failed", failedRow.status, "failed");
  check("the reason is kept for support", failedRow.failureReason, "The card was declined.");
  check("no plan was granted", billing.getActiveSubscription(hookUser.id).planId, "pro");

  group("amounts are cross-checked even on a signed webhook");
  const shortOrder = openOrder("short", "pro", proPlan.amountPaise);
  const shortBody = razorpayBody("payment.captured", shortOrder, { amount: 100 });
  const short = await payments.processWebhook("razorpay", shortBody, razorpayHeaders(shortBody, "evt_verify_short"));
  check("a short payment is rejected, not granted", short.outcome, "rejected");
  check("the order stays open", billing.findPaymentByOrderId(shortOrder).status, "created");
  check("and no second Pro subscription exists", billing.listSubscriptions(hookUser.id).length, 1);

  /* ── the stale-run sweep ─────────────────────────────────────── */

  /* ── the checkout page's order path ─────────────────────────── */

  group("billing details are validated on the server");
  const billingCheck = load("lib/billing-details-server.js");
  const goodBilling = { name: "  Ananya   Rao ", email: "Ananya@Example.TEST", country: "IN", phone: "98765 43210" };
  const vb = billingCheck.validateBillingOnServer(goodBilling);
  check("valid details are accepted", vb.ok, true);
  check("name is trimmed and collapsed", vb.ok && vb.details.name, "Ananya Rao");
  check("email is normalised", vb.ok && vb.details.email, "ananya@example.test");
  check("phone is stored in international form", vb.ok && vb.details.phone, "+919876543210");
  check("a US number validates against the US", billingCheck.validateBillingOnServer({ ...goodBilling, country: "US", phone: "(201) 555-0123" }).ok, true);
  const badCases = [
    ["empty name", { ...goodBilling, name: "" }, "name"],
    ["digits in a name", { ...goodBilling, name: "R2D2 Unit" }, "name"],
    ["bad email", { ...goodBilling, email: "nope@" }, "email"],
    ["unknown country", { ...goodBilling, country: "ZZ" }, "country"],
    ["too-short phone", { ...goodBilling, phone: "12345" }, "phone"],
    ["Indian number with a US code", { ...goodBilling, country: "US", phone: "98765 43210" }, "phone"],
    ["letters in phone", { ...goodBilling, phone: "call me maybe" }, "phone"],
    ["missing everything", {}, "name"],
  ];
  for (const [label, input, field] of badCases) {
    const result = billingCheck.validateBillingOnServer(input);
    check(`refused: ${label}`, !result.ok && Boolean(result.errors[field]), true);
  }
  check("non-Latin legal names are allowed", billingCheck.validateBillingOnServer({ ...goodBilling, name: "अनन्या राव" }).ok, true);

  group("checkout attempts cannot open duplicate orders");
  const attemptBuyer = makeUser("attempts");
  const billingDetails = vb.details;
  const attemptKey = "3f2b6c1e-8a4d-4b7e-9c2a-1d5e6f7a8b9c";
  const first = await payments.startCheckout({
    userId: attemptBuyer.id, plan: basicPlan, gateway: "cashfree",
    customerName: attemptBuyer.name, customerEmail: attemptBuyer.email,
    billing: billingDetails, idempotencyKey: attemptKey,
  });
  check("the order opened", first.ok, true);
  const firstRow = billing.findPaymentByOrderId(first.orderId);
  check("billing details are on the order", [firstRow.billingName, firstRow.billingEmail, firstRow.billingPhone, firstRow.billingCountry], ["Ananya Rao", "ananya@example.test", "+919876543210", "IN"]);
  check("amount and currency come from the plan", [firstRow.amountPaise, firstRow.currency], [basicPlan.amountPaise, basicPlan.currency]);
  check("the chosen gateway is recorded", firstRow.gateway, "cashfree");

  const again = await payments.startCheckout({
    userId: attemptBuyer.id, plan: basicPlan, gateway: "cashfree",
    customerName: attemptBuyer.name, customerEmail: attemptBuyer.email,
    billing: billingDetails, idempotencyKey: attemptKey,
  });
  check("a resubmitted attempt gets the same order back", [again.ok, again.replayed, again.orderId], [true, true, first.orderId]);
  check("and no second payment row exists", billing.listPayments(attemptBuyer.id).length, 1);
  const concurrent = await Promise.all([1, 2, 3].map(() => payments.startCheckout({
    userId: attemptBuyer.id, plan: basicPlan, gateway: "cashfree",
    customerName: attemptBuyer.name, customerEmail: attemptBuyer.email,
    billing: billingDetails, idempotencyKey: attemptKey,
  })));
  check("three parallel repeats all map to the one order", concurrent.map((r) => r.orderId), [first.orderId, first.orderId, first.orderId]);
  check("still one payment row", billing.listPayments(attemptBuyer.id).length, 1);
  // The race the lookup cannot see: two requests both past the lookup,
  // both back from the gateway, both inserting. The UNIQUE index decides.
  let raceError = null;
  try {
    billing.createPayment({
      userId: attemptBuyer.id, planId: "basic", amountPaise: basicPlan.amountPaise, currency: "INR",
      orderId: `order_race_${stamp}`, gateway: "cashfree", environment: "sandbox", mode: "mock",
      receipt: "rcpt_race", idempotencyKey: attemptKey, handoff: { kind: "mock", orderId: `order_race_${stamp}` },
    });
  } catch (error) {
    raceError = error?.name;
  }
  check("a racing second insert for the same attempt is refused by the database", raceError, "DuplicateCheckoutAttempt");
  check("so the loser leaves no row behind", billing.findPaymentByOrderId(`order_race_${stamp}`), null);
  check(
    "the same attempt cannot be reused for a different plan",
    (await payments.startCheckout({ userId: attemptBuyer.id, plan: proPlan, gateway: "cashfree", customerName: "x", customerEmail: "x@x.test", billing: billingDetails, idempotencyKey: attemptKey })).code,
    "CHECKOUT_ATTEMPT_USED",
  );

  group("a cancelled payment grants nothing and can be retried");
  billing.markPaymentFailed(first.orderId, "Cancelled at checkout", "cancelled");
  const afterCancel = await payments.verifyCheckout({ userId: attemptBuyer.id, orderId: first.orderId, payload: {} });
  check("verifying a cancelled order is refused", afterCancel.ok, false);
  check("no plan was activated", billing.getActiveSubscription(attemptBuyer.id)?.planId ?? null, null);
  check(
    "the cancelled attempt's key cannot revive it",
    (await payments.startCheckout({ userId: attemptBuyer.id, plan: basicPlan, gateway: "cashfree", customerName: "x", customerEmail: "x@x.test", billing: billingDetails, idempotencyKey: attemptKey })).code,
    "CHECKOUT_ATTEMPT_USED",
  );
  const retryKey = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const retried = await payments.startCheckout({
    userId: attemptBuyer.id, plan: basicPlan, gateway: "razorpay",
    customerName: attemptBuyer.name, customerEmail: attemptBuyer.email,
    billing: { ...billingDetails, email: "invoices@example.test" }, idempotencyKey: retryKey,
  });
  check("a fresh attempt opens a new order", retried.ok && retried.orderId !== first.orderId, true);
  check("the cancelled order stays cancelled", billing.findPaymentByOrderId(first.orderId).status, "cancelled");

  group("success is verified on the server before anything activates");
  check("nothing is active while the order is open", billing.getActiveSubscription(attemptBuyer.id)?.planId ?? null, null);
  const paid = await payments.verifyCheckout({ userId: attemptBuyer.id, orderId: retried.orderId, payload: {} });
  check("the verified order settles", paid.ok && paid.status, "fulfilled");
  const paidAgain = await payments.verifyCheckout({ userId: attemptBuyer.id, orderId: retried.orderId, payload: {} });
  check("a duplicate confirmation is idempotent", paidAgain.ok && paidAgain.status, "already");
  check("exactly one subscription", billing.listSubscriptions(attemptBuyer.id).length, 1);
  check("exactly one invoice", billing.listInvoices(attemptBuyer.id).length, 1);
  const attemptInvoice = billing.findInvoice(paid.invoiceId);
  check("the invoice is issued to the billing name and email", [attemptInvoice.billingName, attemptInvoice.billingEmail], ["Ananya Rao", "invoices@example.test"]);
  check("the invoice amount is the server's price", attemptInvoice.amountPaise, basicPlan.amountPaise);
  check(
    "a paid attempt cannot be replayed into a new order",
    (await payments.startCheckout({ userId: attemptBuyer.id, plan: basicPlan, gateway: "razorpay", customerName: "x", customerEmail: "x@x.test", billing: billingDetails, idempotencyKey: retryKey })).code,
    "CHECKOUT_ATTEMPT_USED",
  );
  check("the next checkout prefills from this one", billing.latestBillingDetails(attemptBuyer.id), {
    name: "Ananya Rao", email: "invoices@example.test", phone: "+919876543210", country: "IN",
  });

  group("the stale-run sweep credits back what it closes");
  const sweepUser = makeUser("sweep");
  const sweepSub = billing.createSubscription({ userId: sweepUser.id, plan: basicPlan, paymentStatus: "paid" });
  const site = audits.upsertWebsite(sweepUser.id, "sweep.example.com");
  const longAgo = Date.now() - 10 * 60 * 1000;

  /** @param {number} startedAt */
  const makeRunning = (startedAt) => {
    const r = audits.createRunningReport({
      userId: sweepUser.id,
      websiteId: site.id,
      subscriptionId: sweepSub.id,
      url: "https://sweep.example.com/",
      domain: "sweep.example.com",
      planId: sweepSub.planId,
      planName: sweepSub.planName,
      engineVersion: "verify",
      analysisMode: "live",
      features: sweepSub.features,
    });
    run("UPDATE reports SET started_at = ?, heartbeat_at = ? WHERE id = ?", [startedAt, startedAt, r.id]);
    return r;
  };

  for (let i = 0; i < 3; i++) billing.consumeScan(sweepSub.id);
  const stale1 = makeRunning(longAgo);
  const stale2 = makeRunning(longAgo);
  const fresh = makeRunning(Date.now());
  check("three scans consumed", billing.findSubscription(sweepSub.id).scansUsed, 3);

  check("both orphaned runs closed", audits.failStaleReports(), 2);
  check("their scans credited back", billing.findSubscription(sweepSub.id).scansUsed, 1);
  check(
    "the in-flight run is untouched",
    [stale1, stale2, fresh].map((r) => one("SELECT state FROM reports WHERE id = ?", [r.id]).state),
    ["failed", "failed", "running"],
  );
  audits.failStaleReports();
  check("a second sweep does not credit twice", billing.findSubscription(sweepSub.id).scansUsed, 1);

  run("UPDATE subscriptions SET scans_used = 0 WHERE id = ?", [sweepSub.id]);
  run("UPDATE reports SET state = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?", [longAgo, longAgo, fresh.id]);
  audits.failStaleReports();
  check("the credit never goes negative", billing.findSubscription(sweepSub.id).scansUsed, 0);
}

try {
  await main();
} catch (error) {
  console.error(`\nverify crashed: ${error instanceof Error ? error.stack : String(error)}`);
  failures.push("(crashed)");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
