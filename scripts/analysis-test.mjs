// Analysis engine regression: the real engine (compiled from lib/) against
// local fixture websites (scripts/fixtures/sites.mjs).
//
//     node scripts/analysis-test.mjs
//
// Made-up *-fixture.com names are pointed at a local server on port 8080
// by intercepting DNS inside this process only. The address screen sees a
// public address for them, so it runs exactly as in production; the
// connection itself goes to 127.0.0.1. No internet, root or /etc/hosts.

import assert from "node:assert/strict";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requests, startSites } from "./fixtures/sites.mjs";

const PORT = 8080;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(path.join(tmpdir(), "aec-analysis-"));
const outDir = path.join(workDir, "build");

process.env.NODE_ENV = "test";
process.env.DATA_DIR = path.join(workDir, "data");
process.env.ANALYSIS_DEADLINE_MS = "6000";
delete process.env.ALLOW_PRIVATE_ANALYSIS_HOSTS;
for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD"]) delete process.env[name];

/* ── DNS for the fixture names, this process only ─────────────── */

const FIXTURE = /(^|\.)[a-z]+-fixture\.com$/i;
const PUBLIC_LOOKING = "93.184.216.34"; // what the screen sees
const realLookup = dns.lookup;
const realPromiseLookup = dnsPromises.lookup;
dnsPromises.lookup = async (host, options) =>
  FIXTURE.test(host) ? (options?.all ? [{ address: PUBLIC_LOOKING, family: 4 }] : { address: PUBLIC_LOOKING, family: 4 }) : realPromiseLookup(host, options);
dns.lookup = (host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options ?? {};
  if (!FIXTURE.test(host)) return realLookup(host, options, callback);
  // Where the connection actually goes.
  if (opts.all) return process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]);
  return process.nextTick(cb, null, "127.0.0.1", 4);
};

/* ── compile lib/ the way verify.mjs does ─────────────────────── */

const tsconfig = path.join(workDir, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    target: "es2022", module: "commonjs", moduleResolution: "node", esModuleInterop: true, skipLibCheck: true, strict: true,
    outDir, rootDir: projectRoot, baseUrl: projectRoot, paths: { "@/*": ["./*"] }, types: ["node"],
    typeRoots: [path.join(projectRoot, "node_modules", "@types")],
  },
  include: [path.join(projectRoot, "lib/**/*.ts")],
}));
execFileSync(path.join(projectRoot, "node_modules", ".bin", "tsc"), ["-p", tsconfig], { stdio: "inherit" });
const nodeModules = path.join(outDir, "node_modules");
mkdirSync(nodeModules, { recursive: true });
symlinkSync(outDir, path.join(nodeModules, "@"), "dir");
for (const pkg of ["libphonenumber-js", "sharp", "nodemailer", "next", "cheerio"]) {
  try { symlinkSync(path.join(projectRoot, "node_modules", pkg), path.join(nodeModules, pkg), "dir"); } catch { /* optional */ }
}
const req = createRequire(path.join(outDir, "lib", "x.js"));
const engine = req("./analysis/engine.js");
const checks = req("./analysis/checks.js");
const signals = req("./analysis/signals.js");
const fetcher = req("./analysis/fetcher.js");
const { PLANS } = req("./plans.js");

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

const host = (name) => `${name}-fixture.com:${PORT}`;
const scan = (name, plan) => engine.runAnalysis(`http://${host(name)}/`, PLANS[plan].features);
const finding = (outcome, id) => outcome.findings.find((f) => f.id === id);
const quiet = (fn) => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  return Promise.resolve(fn()).finally(() => (console.error = original)).then((value) => ({ value, lines }));
};

let sites;
try {
  sites = await startSites(PORT);
} catch (error) {
  console.error(`Could not listen on 127.0.0.1:${PORT} (${error.code ?? error}). Free that port and run again.`);
  process.exit(1);
}

console.log("analysis engine");
try {
  /* ── B1: one failure stays one failure ─────────────────────────── */

  await check("B1 a check that throws becomes an 'error' result; the scan completes", async () => {
    const target = checks.CHECKS.find((c) => c.id === "seo-title");
    const original = target.run;
    target.run = () => {
      throw new Error("boom");
    };
    try {
      const { value: outcome, lines } = await quiet(() => scan("goodblog", "pro"));
      const broken = finding(outcome, "seo-title");
      assert.equal(broken.status, "error");
      assert.doesNotMatch(broken.detail, /boom/, "the internal message is not shown to the user");
      assert.ok(outcome.findings.filter((f) => f.status !== "error").length >= 40, "every other check still ran");
      assert.ok(lines.some((l) => /check seo-title failed: Error: boom/.test(l)), "the operator log names the check");
    } finally {
      target.run = original;
    }
  });

  await check("B1 a failed calculation marks only the checks that read it", async () => {
    const original = signals.findDuplicates;
    signals.findDuplicates = () => {
      throw new TypeError("bad input");
    };
    try {
      const { value: outcome } = await quiet(() => scan("goodblog", "pro"));
      assert.equal(finding(outcome, "cnt-duplicate-pages").status, "error");
      assert.notEqual(finding(outcome, "cnt-duplicate-titles").status, "error", "a sibling check that doesn't read it is unaffected");
      assert.notEqual(finding(outcome, "cnt-originality").status, "error");
    } finally {
      signals.findDuplicates = original;
    }
  });

  await check("B1 an 'error' result is neither credit nor deduction in the score", () => {
    const base = { category: "content", label: "x", detail: "", fix: "", priority: "low", feature: "basic_page_check" };
    const only = engine.scoreFindings([{ ...base, id: "a", status: "pass", weight: 5 }]);
    const withError = engine.scoreFindings([{ ...base, id: "a", status: "pass", weight: 5 }, { ...base, id: "b", status: "error", weight: 5 }]);
    assert.equal(withError.score, only.score);
    assert.equal(withError.score, 100);
  });

  /* ── B2: every redirect hop is screened ─────────────────────────── */

  await check("B2 the link checker never follows a redirect to a private address", async () => {
    const before = sites.secretHits();
    const result = await fetcher.probe(`http://${host("redirect")}/to-private`);
    assert.equal(result, null);
    assert.equal(sites.secretHits(), before, "the private address was never requested");
  });

  await check("B2 ordinary redirects and loops are still handled", async () => {
    const ok = await fetcher.probe(`http://${host("redirect")}/to-ok`);
    assert.deepEqual(ok, { status: 200, ok: true });
    assert.equal(await fetcher.probe(`http://${host("redirect")}/loop`), null);
  });

  /* ── B3, B4: the clean site is no longer marked down ────────────── */

  let goodPro;
  await check("B3 policy pages don't count as thin content", async () => {
    goodPro = await scan("goodblog", "pro");
    const thin = finding(goodPro, "cnt-thin");
    assert.notEqual(thin.status, "fail", thin.detail);
    assert.match(finding(goodPro, "cnt-depth").evidence, /content page\(s\); policy pages are not counted/);
    assert.equal(finding(goodPro, "pvl-privacy").status, "pass", "the policy pages are still read for the policy checks");
  });

  await check("B4 image size attributes and max-width no longer count as fixed widths", async () => {
    assert.equal(finding(goodPro, "mob-fixed-width").status, "pass", finding(goodPro, "mob-fixed-width").detail);
  });

  let badPro;
  await check("B4 a genuinely fixed 1200px layout is still caught", async () => {
    badPro = await scan("badblog", "pro");
    assert.equal(finding(badPro, "mob-fixed-width").status, "fail");
  });

  /* ── B5: short copies ───────────────────────────────────────────── */

  await check("B5 two word-for-word copies of a short post are reported", () => {
    const dup = finding(badPro, "cnt-duplicate-pages");
    assert.equal(dup.status, "fail", dup.detail);
    assert.match(dup.evidence ?? "", /post-1.*post-2|post-2.*post-1/);
  });

  await check("B5 the clean site's duplicate score is unchanged by the new rule", () => {
    assert.notEqual(finding(goodPro, "cnt-duplicate-pages").status, "error");
    assert.ok(goodPro.metrics.duplicateShare <= 1);
  });

  /* ── B6: an HTML page where a text file should be ───────────────── */

  await check("B6 an HTML page at /ads.txt or /robots.txt is treated as missing", async () => {
    const soft = await scan("softblog", "pro");
    const adsTxt = finding(soft, "tec-ads-txt");
    assert.notEqual(adsTxt.status, "pass", adsTxt.detail);
    assert.doesNotMatch(adsTxt.detail, /published with/);
    assert.match(finding(soft, "tec-robots").detail, /no robots\.txt|not found|could not/i);
  });

  await check("B6 a real ads.txt is still read", () => {
    assert.equal(finding(goodPro, "tec-ads-txt").status, "pass");
    assert.match(finding(goodPro, "tec-ads-txt").detail, /pub-1234567890123456/);
  });

  /* ── B8: the whole scan has a time limit ────────────────────────── */

  await check("B8 a site whose pages never load finishes inside the time limit, marked partial", async () => {
    const t0 = Date.now();
    const outcome = await scan("slowblog", "pro");
    const ms = Date.now() - t0;
    assert.ok(ms < 6000 + 3000, `took ${ms} ms`);
    assert.equal(outcome.metrics.partial, true);
    assert.ok(outcome.score >= 0);
  });

  await check("B8 a normal scan is not marked partial", () => {
    assert.equal(goodPro.metrics.partial, undefined);
  });

  /* ── what was already right stays right ─────────────────────────── */

  await check("locked features cost nothing: Free fetches no sitemap or ads.txt", async () => {
    const start = requests.length;
    await scan("goodblog", "free");
    const paths = requests.slice(start).map((r) => r.path);
    for (const file of ["/sitemap.xml", "/ads.txt"]) assert.ok(!paths.includes(file), `${file} fetched on Free`);
    // robots.txt is read once by the crawler itself, to respect it.
    assert.ok(paths.filter((p) => p === "/robots.txt").length <= 1);
    // Free's own analyzers: essential_pages checks the four policy pages,
    // soft_404 asks for one random address. Nothing else is added.
    const extra = paths.filter((p) => !["/", "/robots.txt"].includes(p));
    const allowed = (p) => /^\/(about|contact|privacy-policy|terms|blog)\/$/.test(p) || /^\/zz-[0-9a-f]{12}-page-check$/.test(p);
    assert.deepEqual(extra.filter((p) => !allowed(p)), [], `unexpected Free requests: ${extra.join(", ")}`);
    assert.ok(paths.length <= 9, `${paths.length} requests`);
  });

  await check("the planted problems on the bad site are still found", () => {
    const failed = new Set(badPro.findings.filter((f) => f.status === "fail").map((f) => f.id));
    for (const id of ["cnt-placeholder", "pvl-contact", "pvl-about", "seo-description", "nav-broken", "mob-viewport", "tec-robots", "tec-ad-density"]) {
      assert.ok(failed.has(id), `${id} should fail`);
    }
    assert.equal(badPro.verdict, "not_ready");
  });

  await check("the clean site is no longer held back by false results", () => {
    // The fixture is served over plain HTTP, so the HTTPS check rightly
    // fails here; it is covered with a real certificate in the audit notes.
    const failed = goodPro.findings.filter((f) => f.status === "fail" && f.id !== "tec-https").map((f) => f.id);
    assert.deepEqual(failed, [], `unexpected fails: ${failed.join(", ")}`);
  });

  /* ── Phase 2a analyzers in a real scan ───────────────────────────── */

  await check("all 47 analyzers run in a Pro scan: the clean site fails none, the broken one fails the planted problems", () => {
    const { ANALYZERS } = req("./analysis/analyzers/index.js");
    const keys = ANALYZERS.map((a) => a.key);
    for (const key of keys) {
      assert.ok(finding(goodPro, key), `${key} ran on the clean site`);
      assert.notEqual(finding(goodPro, key).status, "fail", `${key} on the clean site: ${finding(goodPro, key).detail}`);
      assert.notEqual(finding(goodPro, key).status, "error", key);
      assert.notEqual(finding(badPro, key).status, "error", key);
    }
    assert.equal(keys.length, 47);
    for (const key of ["default_theme_leftovers", "placeholder_text", "essential_pages", "real_word_count", "thin_post_distribution", "privacy_ads_disclosure", "ads_txt_validator", "duplicate_adsense_tag", "hidden_text", "ad_click_encouragement", "conflicting_ad_networks"]) {
      assert.equal(finding(badPro, key).status, "fail", `${key} on the broken site: ${finding(badPro, key).detail}`);
    }
    assert.ok(Object.keys(goodPro.featureVector).length >= keys.length, "each analyzer contributed to the feature vector");
  });

  await check("a Free scan runs only the Free analyzers", async () => {
    const free = await scan("badblog", "free");
    const ran = free.findings.map((f) => f.id);
    for (const key of ["default_theme_leftovers", "placeholder_text", "essential_pages", "soft_404", "parked_domain", "stale_copyright_year"]) assert.ok(ran.includes(key), key);
    for (const key of ["real_word_count", "keyword_stuffing", "ads_txt_validator", "duplicate_adsense_tag"]) assert.ok(!ran.includes(key), `${key} must not run on Free`);
    assert.ok(free.locked.includes("ads_txt_validator"), "Basic analyzers are listed as locked");
  });

  /* ── B7 and the admin's explicit removal ────────────────────────── */

  const { createUser } = req("./db/accounts.js");
  const { createSubscription, getActiveSubscription, revokeFeaturesFromActive } = req("./db/billing.js");
  const { requirePlan, updatePlan } = req("./plan-catalogue.js");
  const { effectiveFeatures } = req("./entitlement.js");
  const { run } = req("./db/index.js");

  await check("B7 chats from customers with priority support are answered first", () => {
    const { listInbox } = req("./chat/service.js");
    const now = Date.now();
    const people = [
      ["free-user", "free", now - 1000],
      ["pro-user", "pro", now - 60_000],
      ["basic-user", "basic", now - 2000],
    ];
    for (const [name, plan, at] of people) {
      const user = createUser({ name, email: `${name}@x.test`, passwordHash: "x" });
      createSubscription({ userId: user.id, plan: requirePlan(plan), paymentStatus: plan === "free" ? "free" : "paid" });
      run(
        "INSERT INTO chat_conversations (id, user_id, status, created_at, updated_at, last_message_at, last_message_preview, last_sender) VALUES (?, ?, 'open', ?, ?, ?, 'help', 'customer')",
        [`conv-${name}`, user.id, at, at, at],
      );
    }
    const inbox = listInbox("all", null);
    assert.equal(inbox[0].customerName, "pro-user", "the Pro customer is first although their message is oldest");
    assert.equal(inbox[0].priority, true);
    assert.deepEqual(inbox.slice(1).map((i) => i.customerName), ["free-user", "basic-user"], "the rest keep newest-first order");
    assert.ok(inbox.slice(1).every((i) => !i.priority));
  });

  await check("turning a feature off keeps it for current subscribers unless the admin removes it now", () => {
    const admin = { id: "admin", email: "a@x.test" };
    const user = createUser({ name: "Existing", email: "existing@x.test", passwordHash: "x" });
    createSubscription({ userId: user.id, plan: requirePlan("basic"), paymentStatus: "paid" });
    const has = (f) => effectiveFeatures(getActiveSubscription(user.id)).includes(f);
    assert.ok(updatePlan("basic", { features: requirePlan("basic").features.filter((f) => f !== "ai_content_check") }, admin).ok);
    assert.equal(has("ai_content_check"), true, "default: kept until the paid period ends");
    assert.ok(revokeFeaturesFromActive("basic", ["ai_content_check"]) >= 1, "at least this subscription changed");
    assert.equal(has("ai_content_check"), false, "explicit removal takes it away now");
    assert.equal(has("originality_check"), true, "other features untouched");
  });

  console.log(`analysis engine: passed (${passed} checks)`);

} finally {
  sites.close();
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
