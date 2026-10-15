// Phase 6: report areas, findings, locked features and PDF export.
//
//     npm run build && node scripts/report-test.mjs
//
// Part A runs the real lib/ modules: the five report areas (analyzer lines,
// legacy rows, smart insights), the per-area counts and the unread-pages
// count the engine records against a local fixture site.
//
// Part B scans the fixture site on Free and Pro through the real pipeline,
// adds a report with Unicode, very long URLs and no metrics, starts the
// production build on that database and checks the report pages in a
// headless browser — then prints each one to a real PDF and reads its text:
// unlocked sections present, locked content absent, the plan's export rule
// applied to printing, and nothing wider than the paper.
//
// The fixture sites listen on port 8080; *-fixture.com names resolve to
// 127.0.0.1 inside this process only.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";
import { findChromium } from "./lib/chromium.mjs";
import "./fixtures/dns-hook.mjs";
import { startSites } from "./fixtures/sites.mjs";
import { isolatedServerEnv } from "./lib/server-env.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = { AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345", CREDENTIALS_SECRET: randomBytes(48).toString("base64") };
Object.assign(process.env, SECRETS, { NODE_ENV: "development", ANALYSIS_DEADLINE_MS: "15000" });
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ANALYSIS_DEMO_FALLBACK", "ALLOW_PRIVATE_ANALYSIS_HOSTS"]) delete process.env[name];

const lib = compileLib(projectRoot, "aec-report-");
const dataDir = path.join(lib.workDir, "data");
process.env.DATA_DIR = dataDir;
const L = lib.require;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    if (error && typeof error.message === "string" && error.message.length > 600) {
      error.message = `${error.message.slice(0, 500)}…`;
      delete error.actual;
    }
    console.log(`  ✗ ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const areas = L("./report/areas.js");
const engine = L("./analysis/engine.js");
const fetcher = L("./analysis/fetcher.js");
const service = L("./audit-service.js");
const accounts = L("./db/accounts.js");
const billing = L("./db/billing.js");
const audits = L("./db/audits.js");
const catalogue = L("./plan-catalogue.js");
const { PLANS } = L("./plans.js");
const { hashPasswordSync } = L("./auth/password.js");

let sites;
try {
  sites = await startSites(8080);
} catch (error) {
  console.error(`Could not listen on 127.0.0.1:8080 (${error.code ?? error}). Free that port and run again.`);
  process.exit(1);
}

console.log("Phase 6 — report, findings & PDF");

/* ════════════════════ Part A — the library ════════════════════ */

const issue = (over) => ({ checkId: "x", categoryId: "content", feature: null, analyzer: null, status: "fail", ...over });

await check("A1 an analyzer line keeps its own area, whatever its score category", () => {
  assert.equal(areas.areaOf(issue({ categoryId: "privacy", analyzer: { category: "trust", items: [] } })), "trust");
  assert.equal(areas.areaOf(issue({ categoryId: "technical", analyzer: { category: "smart", items: [] } })), "smart");
});

await check("A2 legacy rows map by check, then feature, then score category", () => {
  assert.equal(areas.areaOf(issue({ checkId: "pvl-contact", categoryId: "privacy" })), "trust");
  assert.equal(areas.areaOf(issue({ checkId: "pvl-privacy", categoryId: "privacy" })), "policy");
  assert.equal(areas.areaOf(issue({ checkId: "cnt-restricted", feature: "adsense_policy_check" })), "policy");
  assert.equal(areas.areaOf(issue({ checkId: "tec-ad-density", categoryId: "technical", feature: "ad_density_analysis" })), "policy");
  assert.equal(areas.areaOf(issue({ checkId: "seo-title", categoryId: "seo" })), "technical");
  assert.equal(areas.areaOf(issue({ checkId: "mob-viewport", categoryId: "mobile" })), "technical");
  assert.equal(areas.areaOf(issue({ checkId: "nav-menu", categoryId: "navigation" })), "trust");
  assert.equal(areas.areaOf(issue({ checkId: "hidden_text", categoryId: "privacy", feature: "hidden_text" })), "policy", "an analyzer row stored without details");
  assert.equal(areas.areaOf(issue({ checkId: "readiness_timeline", categoryId: "technical", feature: "readiness_timeline" })), "smart");
  assert.equal(areas.areaOf(issue({ checkId: "??", categoryId: "unknown" })), "technical", "anything unknown still lands somewhere");
});

await check("A3 every analyzer in the registry maps to its registry area", () => {
  const { ANALYZER_CATALOG } = L("./analysis/analyzers/catalog.js");
  for (const entry of ANALYZER_CATALOG) {
    assert.equal(areas.areaOf(issue({ checkId: entry.key, feature: entry.key, categoryId: "content" })), entry.category, entry.key);
  }
});

await check("A4 counts per area: open = fail + warn, errors left out; insights split from findings", () => {
  const list = [
    issue({ status: "fail" }), issue({ status: "warn" }), issue({ status: "pass" }), issue({ status: "error" }),
    issue({ status: "warn", analyzer: { category: "smart", items: [] } }),
  ].map((x, i) => ({ ...x, id: String(i) }));
  const counts = Object.fromEntries(areas.countByArea(list).map((c) => [c.area, c]));
  assert.deepEqual([counts.content.open, counts.content.passed, counts.content.total], [2, 1, 3]);
  assert.equal(counts.smart.total, 1);
  assert.equal(counts.policy.total, 0);
  const { findings, insights } = areas.splitInsights(list);
  assert.deepEqual([findings.length, insights.length], [4, 1]);
});

await check("A5 a page-limited scan records how many linked pages it didn't read; a legacy scan doesn't", async () => {
  const one = await engine.runAnalysis("http://badblog-fixture.com:8080/", PLANS.free.features, { pageLimit: 1 });
  assert.ok(one.metrics.unreadPages >= 3, `unread ${one.metrics.unreadPages}`);
  const legacy = await engine.runAnalysis("http://badblog-fixture.com:8080/", PLANS.free.features);
  assert.equal(legacy.metrics.unreadPages, undefined);
});

/* ════════════════════ Part B — pages and PDFs ════════════════════ */

const password = "Str0ng-Password!";
const stamp = Date.now();
fetcher.preflight = async () => ({ ok: true });
const realRun = engine.runAnalysis;
engine.runAnalysis = (domain, features, options) => realRun(`http://${domain}:8080/`, features, options);
const users = {};
const reports = {};
for (const plan of ["free", "pro"]) {
  const u = accounts.createUser({ name: `${plan} reader`, email: `rep-${plan}-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
  billing.createSubscription({ userId: u.id, plan: catalogue.requirePlan(plan), paymentStatus: plan === "free" ? "free" : "paid" });
  users[plan] = accounts.findUserById(u.id);
  const r = await service.startAudit(users[plan], "badblog-fixture.com", { wait: true });
  assert.equal(r.ok, true, `${plan} scan: ${r.message}`);
  reports[plan] = r.report;
}
engine.runAnalysis = realRun;
sites.close?.();

// A Pro report from "an older version": a legacy row with no details, one
// with Unicode and a very long URL, and no metrics at all.
const LONG = `https://unicode-fixture.com/${"very-long-segment-without-any-break-".repeat(8)}end`;
const site = audits.upsertWebsite(users.pro.id, "unicode-fixture.com");
const legacy = audits.createRunningReport({
  userId: users.pro.id, websiteId: site.id, subscriptionId: null, url: "https://unicode-fixture.com/", domain: "unicode-fixture.com",
  planId: "pro", planName: "Pro", engineVersion: "1.0.0", analysisMode: "live", features: PLANS.pro.features,
});
audits.completeReport({
  reportId: legacy.id, score: 52, verdict: "needs_improvement",
  categories: [{ id: "content", name: "Content quality", score: 40, weight: 26, passed: 1, warnings: 1, critical: 1 }],
  passedCount: 1, warningCount: 1, criticalCount: 1, pagesFetched: 3,
  issues: [
    { checkId: "cnt-depth", categoryId: "content", label: "Page depth", status: "fail", priority: "high", detail: "Café — 東京 ✓ naïve résumé: pages are short.", recommendation: "Écrivez davantage.", evidence: LONG },
    { checkId: "pvl-contact", categoryId: "privacy", label: "Contact route", status: "warn", priority: "medium", detail: "No contact page.", feature: "adsense_policy_check" },
    { checkId: "author_bylines", categoryId: "privacy", label: "Author bylines", status: "warn", priority: "low", detail: "No author is named.", feature: "author_bylines",
      analyzer: { category: "trust", confidence: "low", items: Array.from({ length: 11 }, (_, i) => ({ message: `No author on page ${i}.`, pageUrl: `${LONG}/${i}` })) } },
  ],
  features: PLANS.pro.features, locked: [], pages: [], metrics: {}, checksRun: 3,
});

let server;
let browser;
let exitCode = 0;
const port = 5600 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const pdfText = (file) => execFileSync("pdftotext", ["-layout", file, "-"]).toString();

try {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    cwd: projectRoot,
    env: isolatedServerEnv({ ...process.env, ...SECRETS, NODE_ENV: "production", DATA_DIR: dataDir, NEXT_PUBLIC_APP_URL: base, ML_BACKGROUND: "off", RESCANS_BACKGROUND: "off", CHECKOUT_ALERTS_BACKGROUND: "off" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  // The PDF checks print in a real Chromium (scripts/lib/chromium.mjs says
  // where one is looked for).
  const found = findChromium();
  if (found.problem) throw new Error(`Part B needs a browser: ${found.problem}.`);
  browser = await found.chromium.launch({ executablePath: found.executablePath, args: ["--no-sandbox"] });
  const open = async (who, reportId, width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const login = await page.request.post(`${base}/api/auth/login`, { data: { email: who.email, password }, headers: { origin: base } });
    assert.equal(login.status(), 200);
    await page.goto(`${base}/dashboard/reports/${reportId}`, { waitUntil: "load" });
    return { ctx, page };
  };
  const printPdf = async (page, file) => {
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: file, format: "A4" });
    return pdfText(file);
  };

  await check("B1 Pro: findings by area, a Smart insights section, and no insight left among the findings", async () => {
    const { ctx, page } = await open(users.pro, reports.pro.id);
    const areaCards = await page.locator('ul[aria-label="Findings by area"] > li').allTextContents();
    assert.deepEqual(areaCards.map((t) => t.split(/\d/)[0].trim()), ["Content", "Policy", "Trust", "Technical", "Smart insights"]);
    const insightTitles = await page.locator('[data-section="smart-insights"] article h3').allTextContents();
    assert.ok(insightTitles.includes("Approval estimate") && insightTitles.includes("Readiness timeline"), insightTitles.join(","));
    const findingAreas = await page.locator("article[data-status]").evaluateAll((els) => els.map((e) => e.getAttribute("data-area")));
    assert.ok(findingAreas.length > 20 && !findingAreas.includes("smart"), "insights are not listed as findings");
    for (const a of ["content", "policy", "trust", "technical"]) assert.ok(findingAreas.includes(a), a);
    await ctx.close();
  });

  await check("B2 a finding shows status, area, priority, its pages and evidence, and a fix", async () => {
    const { ctx, page } = await open(users.pro, reports.pro.id);
    const card = page.locator("article[data-status]", { hasText: "Real word count" }).first();
    const text = await card.textContent();
    assert.match(text, /Content/);
    assert.match(text, /High priority/);
    assert.match(text, /badblog-fixture\.com:8080\/blog\//, "affected page URL");
    assert.match(text, /How to fix/);
    assert.match(text, /^.*Blocker · scored under Content quality/s);
    await ctx.close();
  });

  await check("B3 Free: locked checks name the plan they are on; the teaser counts unread pages, not unseen issues", async () => {
    const { ctx, page } = await open(users.free, reports.free.id);
    const text = (await page.locator("main").textContent()).replace(/\s+/g, " ");
    const basic = catalogue.cheapestPlanWith("advanced_page_check").name;
    assert.ok(new RegExp(`Available on ${basic} · \\d+ checks didn't run in this scan`).test(text), "locked group names its plan");
    assert.ok(new RegExp(`Available on ${basic} `).test(text), "each locked check names its plan");
    assert.ok(/We found at least \d+ more pages? on your site that this scan didn't read/.test(text), "teaser");
    assert.doesNotMatch(text, /more issues found/i);
    const smart = await page.locator('ul[aria-label="Findings by area"] > li[data-area="smart"]').textContent();
    assert.match(smart, /Not checked on this plan/);
    await ctx.close();
  });

  await check("B4 Free: no premium finding reaches the page or the API", async () => {
    const free = audits.findReport(reports.free.id);
    const issues = audits.listIssues(free.id);
    const allowed = new Set(free.features);
    assert.ok(issues.length > 5);
    for (const i of issues) assert.ok(!i.feature || allowed.has(i.feature), `${i.checkId} (${i.feature}) is not on Free`);
    const { ctx, page } = await open(users.free, reports.free.id);
    const { status, body } = await page.evaluate(async (id) => {
      const res = await fetch(`/api/reports/${id}`);
      return { status: res.status, body: await res.json() };
    }, free.id);
    assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
    assert.ok(body.issues.every((i) => !i.feature || allowed.has(i.feature)));
    const lockedLabel = "Hidden text"; // a Pro analyzer: listed as locked, never as a finding
    assert.equal(await page.locator("article[data-status]", { hasText: lockedLabel }).count(), 0);
    await ctx.close();
  });

  await check("B5 Pro PDF: every unlocked section, nothing locked, no page chrome", async () => {
    const { ctx, page } = await open(users.pro, reports.pro.id);
    const text = await printPdf(page, path.join(lib.workDir, "pro.pdf"));
    for (const heading of ["badblog-fixture.com", "Category scores", "Blockers", "Worth fixing", "checks passed", "Smart insights", "Signals measured", "What to do, in order", "Page by page", "Approval estimate", "How to fix", "Contains the checks included in the Pro plan"]) {
      assert.ok(text.includes(heading), `PDF has "${heading}"`);
    }
    for (const absent of ["didn't run in this scan", "Support chat", "Re-check", "Export PDF", "All reports", "See Basic"]) {
      assert.ok(!text.includes(absent), `PDF leaves out "${absent}"`);
    }
    await ctx.close();
  });

  await check("B6 PDF of an older report: Unicode, a 300-character URL that wraps, a long per-page list, no metrics", async () => {
    const { ctx, page } = await open(users.pro, legacy.id);
    await page.emulateMedia({ media: "print" });
    await page.setViewportSize({ width: 700, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `nothing wider than the paper (overflow ${overflow}px)`);
    const text = await printPdf(page, path.join(lib.workDir, "legacy.pdf"));
    assert.ok(text.includes("Café — 東京 ✓ naïve résumé"), "Unicode survives");
    assert.ok(text.includes("Écrivez davantage."));
    assert.ok(text.replace(/\s+/g, "").includes(LONG.replace("https://", "")), "the long URL is all there, wrapped");
    assert.ok(text.includes("and 3 more like these"), "long lists are summarised");
    assert.ok(text.includes("Low confidence"), "uncertainty is shown");
    assert.ok(/Contact route[\s\S]*Trust/.test(text), "legacy row mapped to Trust");
    await ctx.close();
  });

  await check("B7 printing follows the plan's PDF rule: a Free report prints an upgrade notice, not the report", async () => {
    const { ctx, page } = await open(users.free, reports.free.id);
    assert.equal(await page.getByRole("button", { name: /Export PDF/ }).count(), 0);
    const text = await printPdf(page, path.join(lib.workDir, "free.pdf"));
    assert.match(text, /PDF export is not included in the Free plan/);
    assert.ok(!text.includes("Blockers") && !text.includes("How to fix"), "no report content in the printout");
    // On screen the report is all there.
    await page.emulateMedia({ media: "screen" });
    assert.ok(await page.getByText("How to fix").first().isVisible());
    await ctx.close();
  });

  await check("B8 wording: no finding or summary claims the site will be rejected", async () => {
    const { ctx, page } = await open(users.pro, reports.pro.id);
    const body = await page.locator("main").textContent();
    const hit = body.match(/.{80}(?:automatic no|will be rejected|definitely|guaranteed rejection|single most common reason).{40}/i);
    assert.equal(hit, null, hit?.[0]);
    assert.doesNotMatch(body, /automatic no|will be rejected|definitely|guaranteed rejection|single most common reason/i);
    await ctx.close();
  });

  await check("B9 pricing cards show pages per scan beside scans per month", async () => {
    const html = (await (await fetch(`${base}/pricing`)).text()).replace(/<!-- -->/g, "");
    assert.match(html, /\d+ scans\/month · 1 page\/scan/);
    assert.match(html, /\d+ scans\/month · 25 pages\/scan/);
    assert.match(html, /\d+ scans\/month · 200 pages\/scan/);
  });
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(serverLog.split("\n").slice(-20).join("\n"));
} finally {
  await browser?.close();
  server?.kill();
}

writeFileSync(path.join(lib.workDir, "done"), "");
console.log(`\nreport & PDF: ${exitCode ? "stopped at the first failure" : "passed"} (${passed} checks)`);
process.exit(exitCode);
