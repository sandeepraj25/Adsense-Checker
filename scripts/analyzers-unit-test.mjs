// Unit tests for every registered analyzer, from saved fixture sites.
//
//     node scripts/analyzers-unit-test.mjs
//
// Each folder in scripts/fixtures/analyzers/<key>/<case>/ is a small saved
// website: index.html is "/", about.html is "/about/", blog-x.html is
// "/blog/x/", ads.txt is "/ads.txt" (ads.txt.html serves an HTML page
// there). case.json gives the expected status and, optionally, a phrase
// the findings or summary must contain, a fixed "now", and the status a
// missing page answers with. Every analyzer also runs against empty and
// malformed HTML and must answer with a valid, non-error result.
//
// Analyzers run through the real runner (gate, wrapper, validator) with an
// in-memory crawl: no network at all.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(projectRoot, "scripts", "fixtures", "analyzers");
process.env.NODE_ENV = "test";

// A local WHOIS server (RFC 3912) stands in for IANA and the registries:
// a TLD query is referred to "whois.nic.<tld>", a domain query gets the
// current case's "whois" text. lib/analysis/whois.ts only honours this
// override when NODE_ENV=test.
let whoisAnswer = "No match for domain.";
const whoisQueries = [];
const whoisServer = createServer((socket) => {
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk.toString("utf8");
    if (!input.includes("\r\n")) return;
    const query = input.trim();
    whoisQueries.push(query);
    socket.end(query.includes(".") ? whoisAnswer : `% IANA WHOIS server\ndomain: ${query.toUpperCase()}\nrefer: whois.nic.${query}\n`);
  });
  socket.on("error", () => {});
});
await new Promise((resolve) => whoisServer.listen(0, "127.0.0.1", resolve));
whoisServer.unref(); // never keep the test process alive
process.env.ANALYZER_WHOIS_SERVER = `127.0.0.1:${whoisServer.address().port}`;
process.env.ANALYZER_WHOIS_CACHE = "off";
process.on("exit", () => whoisServer.close());

const lib = compileLib(projectRoot, "aec-analyzers-");
process.env.DATA_DIR = path.join(lib.workDir, "data");
const { ANALYZERS, assertRegistry } = lib.require("./analysis/analyzers/index.js");
const { runAnalyzers } = lib.require("./analysis/analyzers/runner.js");
const { toCrawledPage } = lib.require("./analysis/crawler.js");
const { parseRobotsRules } = lib.require("./analysis/robots.js");
const { CORE_FEATURE_KEYS } = lib.require("./plans.js");
const { CHECKS } = lib.require("./analysis/checks.js");
process.on("exit", () => lib.cleanup());

const DEFAULT_ORIGIN = "https://home-kitchen.test";

function pathFor(file) {
  if (file === "index.html") return "/";
  if (file.endsWith(".txt")) return `/${file}`;
  if (/\.(?:xml|css|js|jpg|png|webp|woff2|pdf)$/.test(file)) return `/${file}`;
  if (/\.txt\.html$/.test(file)) return `/${file.replace(/\.html$/, "")}`;
  const stem = file.replace(/\.html$/, "");
  if (stem.startsWith("blog-")) return `/blog/${stem.slice(5)}/`;
  return `/${stem}/`;
}

function response(url, body, { status = 200, type = "text/html; charset=utf-8", maxBytes = Infinity } = {}) {
  const truncated = body.length > maxBytes;
  const text = truncated ? body.slice(0, maxBytes) : body;
  return { requestedUrl: url, finalUrl: url, status, ok: status >= 200 && status < 300, contentType: type, body: text, bytes: text.length, ms: 1, truncated, headers: { "content-type": type }, redirects: [] };
}

const TYPES = { txt: "text/plain", xml: "application/xml", css: "text/css", js: "application/javascript", jpg: "image/jpeg", png: "image/png", webp: "image/webp", woff2: "font/woff2", pdf: "application/pdf" };
function typeOf(file) {
  const ext = file.match(/\.([a-z0-9]+)$/)?.[1] ?? "html";
  return TYPES[ext] ?? "text/html; charset=utf-8";
}

/** An in-memory site with the crawl API the runner uses. */
function fixtureSite(files, options = {}) {
  const ORIGIN = options.origin ?? DEFAULT_ORIGIN;
  const served = new Map();
  for (const [file, body] of Object.entries(files)) {
    if (file === "case.json" || file.startsWith("_")) continue;
    served.set(`${ORIGIN}${pathFor(file)}`, { body, type: file.endsWith(".txt.html") ? "text/html; charset=utf-8" : typeOf(file) });
  }
  // Synthetic large files: { "big.js": 1500000 } serves that many bytes.
  for (const [file, size] of Object.entries(options.padBytes ?? {})) {
    served.set(`${ORIGIN}${pathFor(file)}`, { body: "a".repeat(size), type: typeOf(file) });
  }
  const unknownStatus = options.unknownStatus ?? 404;
  const unknownBody = files["_unknown.html"] ?? "<h1>Not found</h1>";
  const answer = (url, opts = {}) => {
    const clean = url.split("#")[0];
    // The cloaking fixtures show Googlebot a different homepage.
    if (files["_googlebot.html"] && /Googlebot/.test(opts.userAgent ?? "") && clean === `${ORIGIN}/`) {
      return response(clean, files["_googlebot.html"], { maxBytes: opts.maxBytes });
    }
    const hit = served.get(clean);
    return hit ? response(clean, hit.body, { type: hit.type, maxBytes: opts.maxBytes }) : response(clean, unknownBody, { status: unknownStatus });
  };

  const pages = [...served.entries()]
    .filter(([url, v]) => !url.endsWith(".txt") && v.type.startsWith("text/html"))
    .map(([url]) => url)
    .map((url) => toCrawledPage(url, answer(url)))
    .sort((a, b) => (a.url === `${ORIGIN}/` ? -1 : b.url === `${ORIGIN}/` ? 1 : 0));
  if (pages.length === 0 || pages[0].url !== `${ORIGIN}/`) pages.unshift(toCrawledPage(`${ORIGIN}/`, response(`${ORIGIN}/`, files["index.html"] ?? "")));
  const home = pages[0];

  const policyLinks = {};
  const patterns = { privacy: /privacy/i, contact: /contact/i, about: /about/i, terms: /terms/i };
  for (const link of home.analysis.links) {
    if (!link.absolute || !link.internal) continue;
    for (const [kind, re] of Object.entries(patterns)) {
      if (!policyLinks[kind] && (re.test(link.absolute) || re.test(link.text))) policyLinks[kind] = { url: link.absolute, label: link.text };
    }
  }

  const robotsText = files["robots.txt"];
  const crawl = {
    pages: () => pages,
    robots: async () => (robotsText ? parseRobotsRules(robotsText) : null),
    resource: async (url, opts) => answer(url, opts),
    probe: async (url) => {
      const r = answer(url);
      return { status: r.status, ok: r.ok };
    },
    clock: { remaining: () => 30_000, allow: (ms) => ms, partial: () => false },
  };
  const host = new URL(ORIGIN).hostname;
  const site = {
    origin: ORIGIN,
    domain: host,
    host,
    home,
    https: true,
    policyLinks,
    internalUrls: home.analysis.links.filter((l) => l.internal && l.absolute).map((l) => l.absolute),
    snapshot: {},
  };
  return { crawl, site };
}

async function runOn(def, files, options = {}) {
  whoisAnswer = options.whois ?? "No match for domain.";
  const { crawl, site } = fixtureSite(files, options);
  if (options.now) {
    const fixed = new Date(options.now).getTime();
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fixed]));
      }
      static now() {
        return fixed;
      }
    };
    try {
      return (await runAnalyzers({ defs: [def], features: new Set([def.key]), crawl, site })).findings[0];
    } finally {
      globalThis.Date = RealDate;
    }
  }
  return (await runAnalyzers({ defs: [def], features: new Set([def.key]), crawl, site })).findings[0];
}

function readCase(dir) {
  const files = {};
  for (const name of readdirSync(dir)) files[name] = readFileSync(path.join(dir, name), "utf8");
  return { files, spec: JSON.parse(files["case.json"]) };
}

test("the registry and catalogue agree, with no key colliding with an existing feature or check", () => {
  assert.deepEqual(assertRegistry(ANALYZERS, undefined, [...CORE_FEATURE_KEYS, ...CHECKS.map((c) => c.id)]), []);
});

for (const def of ANALYZERS) {
  const dir = path.join(FIXTURES, def.key);
  test(`${def.key}: has a pass case and a failing case`, () => {
    assert.ok(existsSync(dir), `no fixtures for ${def.key}`);
    const specs = readdirSync(dir).map((c) => JSON.parse(readFileSync(path.join(dir, c, "case.json"), "utf8")).expect);
    assert.ok(specs.includes("pass"), "a pass case");
    assert.ok(specs.some((s) => s === "fail" || s === "warn"), "a fail or warn case");
  });

  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    test(`${def.key}: ${name}`, async () => {
      const { files, spec } = readCase(path.join(dir, name));
      const line = await runOn(def, files, spec);
      const detail = `${line.status}: ${line.detail} | ${JSON.stringify(line.analyzer?.items ?? []).slice(0, 400)}`;
      assert.equal(line.status, spec.expect, detail);
      if (spec.itemMatch) {
        const text = [line.detail, ...(line.analyzer?.items ?? []).flatMap((i) => [i.message, i.evidence ?? ""])].join(" \n ");
        assert.match(text, new RegExp(spec.itemMatch, "i"), detail);
      }
      if (spec.summaryMatch) assert.match(line.detail, new RegExp(spec.summaryMatch, "i"), detail);
      if (line.status !== "pass") assert.ok(line.fix.length > 0 || line.analyzer.confidence === "low" || /Uncertain|Not /.test(line.detail), "a non-pass explains what to do");
    });
  }

  test(`${def.key}: empty and malformed HTML give a valid result, never an error`, async () => {
    for (const html of ["", "<<<div><p>unclosed <b>tags <script>var x = '</p>", "\u0000\u0001 binary-ish �"]) {
      const line = await runOn(def, { "index.html": html });
      assert.notEqual(line.status, "error", `${JSON.stringify(html).slice(0, 30)} → ${line.detail}`);
      assert.ok(["pass", "warn", "fail"].includes(line.status));
    }
  });

  // Error and timeout cases: the network under the analyzer fails. The
  // homepage was read (as in a real scan); every further request the
  // analyzer makes either throws with an internal-looking message or never
  // answers. The line must stay well-formed, finish inside the time
  // budget, and never repeat the internal message to the customer.
  test(`${def.key}: failing and hanging requests give a contained result, never a leak`, async () => {
    const dir = path.join(FIXTURES, def.key);
    const first = readdirSync(dir).sort()[0];
    const { files, spec } = readCase(path.join(dir, first));
    const SECRET = "connect ECONNREFUSED 10.0.0.7:5432 /srv/app/internal.js";
    for (const mode of ["throws", "hangs"]) {
      const { crawl, site } = fixtureSite(files, spec);
      const fail = () => (mode === "throws" ? Promise.reject(new Error(SECRET)) : new Promise(() => {}));
      crawl.resource = fail;
      crawl.probe = fail;
      crawl.robots = fail;
      crawl.clock = { remaining: () => 600, allow: (ms) => Math.min(ms, 600), partial: () => false };
      whoisAnswer = spec.whois ?? "No match for domain.";
      const started = Date.now();
      const quiet = console.error;
      console.error = () => {};
      let line;
      try {
        line = (await runAnalyzers({ defs: [def], features: new Set([def.key]), crawl, site })).findings[0];
      } finally {
        console.error = quiet;
      }
      assert.ok(Date.now() - started < 5_000, `${mode}: finished in ${Date.now() - started} ms`);
      assert.ok(["pass", "warn", "fail", "error"].includes(line.status), `${mode}: ${line.status}`);
      const shown = JSON.stringify([line.detail, line.fix, line.evidence, line.analyzer?.items ?? []]);
      assert.ok(!shown.includes("ECONNREFUSED") && !shown.includes("/srv/app"), `${mode}: internal detail shown: ${shown.slice(0, 200)}`);
    }
  });
}
