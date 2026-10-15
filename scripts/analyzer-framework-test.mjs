// Phase 1: the shared crawler, the analyzer contract, the runner, feature
// registration and storage — against the real compiled lib/ and the local
// fixture websites (scripts/fixtures/sites.mjs, port 8080).
//
//     node scripts/analyzer-framework-test.mjs
//
// The analyzers here are test doubles passed straight to the engine; none
// is registered in the product, so nothing is advertised that does not run.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { compileLib } from "./lib/compile-lib.mjs";
import { installFixtureDns } from "./lib/fixture-dns.mjs";
import { requests, startSites } from "./fixtures/sites.mjs";

const PORT = 8080;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_ENV = "test";
process.env.ANALYSIS_DEADLINE_MS = "6000";
delete process.env.ALLOW_PRIVATE_ANALYSIS_HOSTS;
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD"]) delete process.env[name];

installFixtureDns();
const lib = compileLib(projectRoot, "aec-framework-");
process.env.DATA_DIR = path.join(lib.workDir, "data");
const req = lib.require;

const engine = req("./analysis/engine.js");
const { Crawl } = req("./analysis/crawler.js");
const { parseRobotsRules } = req("./analysis/robots.js");
const runner = req("./analysis/analyzers/runner.js");
const registry = req("./analysis/analyzers/index.js");
const { seedFeatureMappings, SEEDED_FEATURES_KEY } = req("./db/feature-seeds.js");
const { MIGRATIONS } = req("./db/schema.js");
const { toReportIssue } = req("./db/types.js");
const { PLANS, FEATURE_KEYS, CORE_FEATURE_KEYS } = req("./plans.js");
const { CHECKS } = req("./analysis/checks.js");

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
const quiet = async (fn) => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
};
const url = (name, p = "/") => `http://${name}-fixture.com:${PORT}${p}`;
const since = (start) => requests.slice(start).map((r) => `${r.host}${r.path}`);

/** A test analyzer; `calls` counts how often the gate let it run. */
function analyzer(key, overrides = {}) {
  const def = {
    key,
    name: `Test ${key}`,
    category: "content",
    defaultPlan: "basic",
    scope: "site",
    calls: 0,
    run: () => ({ status: "pass", findings: [], recommendation: "" }),
    ...overrides,
  };
  const run = def.run;
  def.run = (ctx) => {
    def.calls += 1;
    return run(ctx);
  };
  return def;
}

let sites;
try {
  sites = await startSites(PORT);
} catch (error) {
  console.error(`Could not listen on 127.0.0.1:${PORT} (${error.code ?? error}). Free that port and run again.`);
  lib.cleanup();
  process.exit(1);
}
console.log("analyzer framework");
try {
  /* ── shared crawler ─────────────────────────────────────────────── */

  await check("each URL is fetched once, however many analyzers ask for it", async () => {
    const asks = [];
    const reader = (key) =>
      analyzer(key, {
        run: async (ctx) => {
          const file = await ctx.fetchResource(`${ctx.siteMeta.origin}/ads.txt`, { accept: "text/plain" });
          const robots = await ctx.robots();
          asks.push(Boolean(file) && Boolean(robots));
          return { status: "pass", findings: [], recommendation: "" };
        },
      });
    const start = requests.length;
    const defs = [reader("t_reader_a"), reader("t_reader_b"), reader("t_reader_c")];
    await engine.runAnalysis(url("goodblog"), [...PLANS.pro.features, ...defs.map((d) => d.key)], { analyzers: defs });
    const hits = since(start);
    assert.deepEqual(asks, [true, true, true]);
    assert.equal(hits.filter((h) => h.endsWith("/ads.txt")).length, 1, "ads.txt once, shared by the checks and three analyzers");
    assert.equal(hits.filter((h) => h.endsWith("/robots.txt")).length, 1, "robots.txt once");
    // No URL is requested twice in the whole scan — not even a HEAD link
    // check for a page that was already read in full.
    const counts = new Map();
    for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
    const repeated = [...counts].filter(([, n]) => n > 1).map(([h]) => h);
    assert.deepEqual(repeated, [], `requested more than once: ${repeated.join(", ")}`);
  });

  await check("inner pages that robots.txt closes are not fetched; the homepage always is", async () => {
    const start = requests.length;
    const outcome = await engine.runAnalysis(url("robotsblog"), PLANS.pro.features);
    const hits = since(start);
    assert.ok(hits.includes("robotsblog-fixture.com/"), "homepage read");
    assert.ok(hits.some((h) => h.includes("/open/")), "allowed pages read");
    const toPrivate = requests.slice(start).filter((r) => r.path.startsWith("/private/"));
    assert.deepEqual(toPrivate, [], "no request of any kind (GET or HEAD link check) to /private/");
    assert.ok(outcome.pageUrls.every((u) => !u.includes("/private/")));
  });

  await check("requests in flight never exceed the concurrency limit", async () => {
    sites.resetInFlight();
    const crawl = new Crawl({ deadlineMs: 10_000, maxPages: 5, concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => crawl.resource(url("redirect", `/slow?ms=200&i=${i}`), { accept: "text/plain" })));
    assert.equal(sites.maxInFlight(), 2);
    assert.equal(crawl.stats.requests, 6);
  });

  await check("content pages stop at maxPages; repeats come from the cache", async () => {
    const crawl = new Crawl({ deadlineMs: 10_000, maxPages: 2, concurrency: 3 });
    const home = await crawl.homeCandidate(url("goodblog"));
    crawl.adoptHome(home);
    const first = await crawl.page(url("goodblog", "/about/"));
    const second = await crawl.page(url("goodblog", "/terms/"));
    const again = await crawl.page(url("goodblog", "/about/"));
    assert.equal(first.kind, "page");
    assert.deepEqual([second.kind, second.reason], ["skipped", "budget"]);
    assert.equal(again, first, "same result object, no second request");
    assert.equal(crawl.pages().length, 2);
  });

  await check("the crawler's requests are screened at every redirect hop", async () => {
    const before = sites.secretHits();
    const crawl = new Crawl({ deadlineMs: 10_000, maxPages: 2 });
    assert.equal(await crawl.resource(url("redirect", "/to-private")), null);
    assert.equal(sites.secretHits(), before, "the private address was never requested");
  });

  await check("once the time budget is spent, nothing new starts", async () => {
    const crawl = new Crawl({ deadlineMs: 700, maxPages: 5 });
    await crawl.resource(url("redirect", "/slow?ms=400"), { accept: "text/plain" });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await crawl.resource(url("redirect", "/slow?ms=10&late=1"), { accept: "text/plain" }), null);
    assert.equal(crawl.clock.partial(), true);
  });

  /* ── robots.txt rules ───────────────────────────────────────────── */

  await check("robots.txt: groups, longest match, Allow on ties, * and $", () => {
    const rules = parseRobotsRules(
      "User-agent: *\nDisallow: /private/\nAllow: /private/ok\nDisallow: /*.pdf$\n\nUser-agent: AdSenseEligibilityChecker\nDisallow: /only-us/\n\nSitemap: https://x.test/s.xml",
    );
    assert.equal(rules.allows("/private/x", "OtherBot"), false);
    assert.equal(rules.allows("/private/ok/1", "OtherBot"), true, "longer Allow wins");
    assert.equal(rules.allows("/file.pdf", "OtherBot"), false);
    assert.equal(rules.allows("/file.pdf?x=1", "OtherBot"), true, "$ anchors the end");
    assert.equal(rules.allows("/only-us/a", "AdSenseEligibilityChecker"), false, "our own group applies to us");
    assert.equal(rules.allows("/private/x", "AdSenseEligibilityChecker"), true, "and replaces the * group");
    assert.deepEqual(rules.sitemaps, ["https://x.test/s.xml"]);
    assert.equal(parseRobotsRules("User-agent: *\nDisallow:\n").allows("/anything", "x"), true, "empty Disallow allows all");
  });

  /* ── the gate and the error wrapper ─────────────────────────────── */

  let mixed;
  await check("an analyzer whose feature the account lacks is never called", async () => {
    const on = analyzer("t_gate_on");
    const off = analyzer("t_gate_off", {
      run: () => {
        throw new Error("must not run");
      },
    });
    const start = requests.length;
    const outcome = await engine.runAnalysis(url("goodblog"), [...PLANS.free.features, "t_gate_on"], { analyzers: [on, off] });
    assert.equal(on.calls, 1);
    assert.equal(off.calls, 0, "zero calls, zero requests");
    assert.ok(outcome.findings.some((f) => f.id === "t_gate_on"));
    assert.ok(!outcome.findings.some((f) => f.id === "t_gate_off"));
    assert.ok(since(start).every((h) => !h.endsWith("/ads.txt")), "no work for the locked one");
  });

  await check("a throwing, hanging or malformed analyzer is an 'error' line; the rest of the scan stands", async () => {
    const defs = [
      analyzer("t_throws", { run: () => { throw new Error("internal detail"); } }),
      analyzer("t_hangs", { timeoutMs: 300, run: () => new Promise(() => {}) }),
      analyzer("t_bad_status", { run: () => ({ status: "great", findings: [], recommendation: "" }) }),
      analyzer("t_bad_feature", { run: () => ({ status: "pass", findings: [], recommendation: "", features: { x: Number.NaN } }) }),
      analyzer("t_fine", {
        run: () => ({
          status: "fail",
          score: 140,
          findings: [{ message: "  Found   a problem ", evidence: "<b>x</b>", pageUrl: "javascript:alert(1)" }],
          recommendation: "Fix it.",
          features: { problems: 1 },
        }),
      }),
    ];
    const { value: outcome, lines } = await quiet(() =>
      engine.runAnalysis(url("goodblog"), [...PLANS.basic.features, ...defs.map((d) => d.key)], { analyzers: defs }),
    );
    mixed = outcome;
    const by = (id) => outcome.findings.find((f) => f.id === id);
    for (const id of ["t_throws", "t_hangs", "t_bad_status", "t_bad_feature"]) {
      assert.equal(by(id).status, "error", id);
      assert.doesNotMatch(by(id).detail, /internal detail|great|NaN/);
    }
    assert.ok(lines.some((l) => /analyzer t_throws failed: Error: internal detail/.test(l)));
    assert.ok(lines.some((l) => /analyzer t_hangs failed: Error: timed out/.test(l)));
    const fine = by("t_fine");
    assert.equal(fine.status, "fail");
    assert.equal(fine.analyzer.score, 100, "score clamped to 0–100");
    assert.equal(fine.analyzer.items[0].message, "Found a problem", "whitespace normalised");
    assert.equal(fine.analyzer.items[0].pageUrl, undefined, "non-http URLs dropped");
    assert.equal(fine.fix, "Fix it.");
    assert.ok(outcome.findings.filter((f) => !f.id.startsWith("t_")).length >= 30, "the built-in checks all ran");
  });

  await check("feature vector: prefixed by analyzer key, with status; errors contribute nothing", () => {
    assert.equal(mixed.featureVector["t_fine.problems"], 1);
    assert.equal(mixed.featureVector["t_fine.status"], 0);
    assert.ok(!Object.keys(mixed.featureVector).some((k) => k.startsWith("t_throws.")));
  });

  await check("errors are left out of the score; smart analyzers are shown but never scored", async () => {
    const smart = analyzer("t_smart", { category: "smart", run: () => ({ status: "fail", findings: [{ message: "x" }], recommendation: "y" }) });
    // Compare one scan's scoring with and without the line, so timing-
    // dependent checks (homepage speed) cannot make two scans differ.
    const withSmart = await engine.runAnalysis(url("goodblog"), [...PLANS.basic.features, "t_smart"], { analyzers: [smart] });
    const without = withSmart.findings.filter((f) => f.id !== "t_smart");
    assert.equal(engine.scoreFindings(withSmart.findings).score, engine.scoreFindings(without).score);
    assert.equal(withSmart.findings.find((f) => f.id === "t_smart").weight, 0);
    const erroring = [...without, { ...without[0], id: "t_err", status: "error", weight: 9 }];
    assert.equal(engine.scoreFindings(erroring).score, engine.scoreFindings(without).score);
  });

  await check("page-scope analyzers run once per page and combine to the worst status", async () => {
    const seen = [];
    const perPage = analyzer("t_per_page", {
      scope: "page",
      run: (ctx) => {
        seen.push(ctx.url);
        assert.ok(typeof ctx.$("title").text() === "string", "cheerio document available");
        const bad = ctx.url.includes("/about/");
        return { status: bad ? "warn" : "pass", score: bad ? 50 : 100, findings: bad ? [{ message: "About page note" }] : [], recommendation: bad ? "Look." : "", features: { n: bad ? 1 : 0 } };
      },
    });
    const outcome = await engine.runAnalysis(url("goodblog"), [...PLANS.pro.features, "t_per_page"], { analyzers: [perPage] });
    const line = outcome.findings.find((f) => f.id === "t_per_page");
    assert.equal(seen.length, outcome.pagesFetched, "one call per page read");
    assert.equal(new Set(seen).size, seen.length, "never twice for a page");
    assert.equal(line.status, "warn");
    assert.match(line.analyzer.items[0].pageUrl, /\/about\/$/, "the page is attached to its finding");
    assert.equal(line.analyzer.score, Math.round((50 + 100 * (seen.length - 1)) / seen.length));
  });

  /* ── storage ────────────────────────────────────────────────────── */

  await check("analyzer details are stored with the report and read back; older rows read as none", () => {
    const { createUser } = req("./db/accounts.js");
    const { createSubscription } = req("./db/billing.js");
    const { requirePlan } = req("./plan-catalogue.js");
    const audits = req("./db/audits.js");
    const user = createUser({ name: "S", email: "store@x.test", passwordHash: "x" });
    const sub = createSubscription({ userId: user.id, plan: requirePlan("pro"), paymentStatus: "paid" });
    const site = audits.upsertWebsite(user.id, "goodblog-fixture.com");
    const report = audits.createRunningReport({ userId: user.id, websiteId: site.id, subscriptionId: sub.id, url: url("goodblog"), domain: "goodblog-fixture.com", planId: "pro", planName: "Pro", engineVersion: "test", analysisMode: "live", features: PLANS.pro.features });
    const line = mixed.findings.find((f) => f.id === "t_fine");
    audits.completeReport({
      reportId: report.id, score: 50, verdict: "needs_improvement", categories: [], passedCount: 0, warningCount: 0, criticalCount: 1, pagesFetched: 1,
      issues: [{ checkId: line.id, categoryId: line.category, label: line.label, status: line.status, priority: line.priority, detail: line.detail, recommendation: line.fix, evidence: line.evidence, feature: null, analyzer: line.analyzer }],
      features: [], locked: [], pages: [], metrics: {}, checksRun: 1,
    });
    const [stored] = audits.listIssues(report.id);
    assert.deepEqual(stored.analyzer, line.analyzer);
    const legacy = toReportIssue({ id: "i", report_id: "r", check_id: "cnt-depth", category_id: "content", label: "x", status: "pass", priority: "low", detail: "d", recommendation: null, evidence: null, sort_order: 0, feature: null });
    assert.equal(legacy.analyzer, null);
    assert.equal(toReportIssue({ ...legacy, report_id: "r", check_id: "c", category_id: "content", sort_order: 0, details_json: "{broken" }).analyzer, null);
  });

  await check("migration V10 applies cleanly to a version-9 database with existing report lines", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
    db.prepare("INSERT INTO report_issues (id, report_id, check_id, category_id, label, status, priority, detail) VALUES ('i1','r1','cnt-depth','content','Depth','pass','low','ok')").run();
    db.exec(MIGRATIONS[9]);
    const row = db.prepare("SELECT * FROM report_issues WHERE id = 'i1'").get();
    assert.equal(row.details_json, null);
    assert.equal(toReportIssue({ ...row }).analyzer, null);
    db.close();
  });

  await check("migration V11 (WHOIS cache) applies cleanly to a version-10 database", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    for (const sql of MIGRATIONS.slice(0, 10)) db.exec(sql);
    db.exec(MIGRATIONS[10]);
    const cols = db.prepare("PRAGMA table_info(whois_cache)").all().map((c) => c.name);
    assert.deepEqual(cols, ["domain", "server", "created_on", "status", "detail", "fetched_at"]);
    assert.throws(() => db.prepare("INSERT INTO whois_cache (domain, status, fetched_at) VALUES ('x.test', 'bogus', 1)").run(), "status is constrained");
    db.close();
  });

  /* ── feature registration ───────────────────────────────────────── */

  await check("a new feature key is seeded once onto its default plan and those above, never re-added", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE plans (id TEXT PRIMARY KEY, features_json TEXT NOT NULL, updated_at INTEGER, updated_by TEXT)");
    db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)");
    const insert = db.prepare("INSERT INTO plans (id, features_json, updated_at, updated_by) VALUES (?, ?, 1, 'admin@x')");
    insert.run("free", JSON.stringify(["basic_page_check"]));
    insert.run("basic", JSON.stringify(["basic_page_check", "advanced_page_check"]));
    insert.run("pro", JSON.stringify(["basic_page_check", "pdf_export"]));
    const features = (id) => JSON.parse(db.prepare("SELECT features_json FROM plans WHERE id = ?").get(id).features_json);
    const catalog = [
      { key: "t_new_basic", label: "x", does: "x", defaultPlan: "basic", category: "content", scope: "site" },
      { key: "t_new_free", label: "x", does: "x", defaultPlan: "free", category: "content", scope: "page" },
    ];
    assert.deepEqual(seedFeatureMappings(db, catalog).sort(), ["t_new_basic", "t_new_free"]);
    assert.deepEqual(features("free"), ["basic_page_check", "t_new_free"]);
    assert.deepEqual(features("basic"), ["basic_page_check", "advanced_page_check", "t_new_basic", "t_new_free"]);
    assert.ok(features("pro").includes("pdf_export") && features("pro").includes("t_new_basic"), "existing keys untouched");
    assert.equal(db.prepare("SELECT updated_by FROM plans WHERE id = 'basic'").get().updated_by, "admin@x", "the admin stays 'last edited by'");

    // The admin takes one off Basic; a later start must not put it back.
    db.prepare("UPDATE plans SET features_json = ? WHERE id = 'basic'").run(JSON.stringify(["basic_page_check", "advanced_page_check", "t_new_free"]));
    assert.deepEqual(seedFeatureMappings(db, catalog), []);
    assert.ok(!features("basic").includes("t_new_basic"));
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SEEDED_FEATURES_KEY).value).sort(), ["t_new_basic", "t_new_free"]);

    // A damaged record seeds nothing rather than overriding the admin.
    db.prepare("UPDATE app_settings SET value = '{bad' WHERE key = ?").run(SEEDED_FEATURES_KEY);
    const { value: none } = { value: seedFeatureMappings(db, [...catalog, { ...catalog[0], key: "t_newer" }]) };
    assert.deepEqual(none, []);
    db.close();
  });

  await check("the registry and catalogue agree; keys cannot collide with existing features or checks", () => {
    assert.deepEqual(registry.assertRegistry(registry.ANALYZERS, undefined, [...CORE_FEATURE_KEYS, ...CHECKS.map((c) => c.id)]), []);
    const cat = [{ key: "t_a", label: "A", does: "a", defaultPlan: "free", category: "content", scope: "site" }, { key: "t_orphan", label: "O", does: "o", defaultPlan: "free", category: "content", scope: "site" }];
    const problems = registry.assertRegistry(
      [analyzer("t_a", { defaultPlan: "pro" }), analyzer("t_a"), analyzer("basic_page_check")],
      cat,
      ["basic_page_check"],
      [],
    );
    assert.ok(problems.includes("duplicate analyzer key t_a"));
    assert.ok(problems.includes("t_a: default plan differs from the catalogue"));
    assert.ok(problems.includes("basic_page_check collides with an existing feature or check id"));
    assert.ok(problems.includes("catalogue entry t_orphan has no analyzer"));
  });

  await check("the 19 core features are unchanged and still first", () => {
    assert.equal(CORE_FEATURE_KEYS.length, 19);
    assert.deepEqual(FEATURE_KEYS.slice(0, 19), [...CORE_FEATURE_KEYS]);
    assert.ok(PLANS.pro.features.includes("pdf_export") && PLANS.free.features.includes("https_check"));
  });

  console.log(`analyzer framework: passed (${passed} checks)`);
} finally {
  sites.close();
  lib.cleanup();
}
process.exit(0);
