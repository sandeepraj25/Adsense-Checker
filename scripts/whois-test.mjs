// WHOIS client (lib/analysis/whois.ts) against a local mock server.
//
//     node --test scripts/whois-test.mjs
//
// No real registry is contacted: in tests ANALYZER_WHOIS_SERVER points
// every query at the mock. The address-screening tests run with the
// override switched off.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";

process.env.NODE_ENV = "test";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = compileLib(projectRoot, "aec-whois-");
process.env.DATA_DIR = path.join(lib.workDir, "data");
const whois = lib.require("./analysis/whois.js");

const queries = [];
const answers = new Map();
const server = createServer((socket) => {
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk.toString("utf8");
    if (!input.includes("\r\n")) return;
    const query = input.trim();
    queries.push(query);
    if (!query.includes(".")) return void socket.end(`refer: whois.nic.${query}\n`);
    const answer = answers.get(query);
    if (answer === "HANG") return; // never answers
    socket.end(answer ?? "No match for domain.\n");
  });
  socket.on("error", () => {});
});

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  process.env.ANALYZER_WHOIS_SERVER = `127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  lib.cleanup();
});

test("reads creation dates in the common registry formats", () => {
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  assert.equal(iso(whois.parseWhoisDate("2015-03-01T10:00:00Z")), "2015-03-01");
  assert.equal(iso(whois.parseWhoisDate("2015-03-01T10:00:00.0Z")), "2015-03-01");
  assert.equal(iso(whois.parseWhoisDate("2015-03-01 10:00:00+05:30")), "2015-03-01");
  assert.equal(iso(whois.parseWhoisDate("2015.03.01")), "2015-03-01");
  assert.equal(iso(whois.parseWhoisDate("01-Mar-2015")), "2015-03-01");
  assert.equal(iso(whois.parseWhoisDate("Mar 1 2015")), "2015-03-01");
  assert.equal(iso(whois.parseWhoisDate("01.03.2015")), "2015-03-01");
  assert.equal(whois.parseWhoisDate("sometime last year"), null);
  assert.equal(whois.parseWhoisDate("1800-01-01"), null, "implausible years are rejected");
  assert.equal(iso(whois.readCreationDate("Domain Name: X\nRegistrar: Y\nCreation Date: 2019-07-04T00:00:00Z\n")), "2019-07-04");
  assert.equal(iso(whois.readCreationDate("domain:  x.in\nRegistered on: 2020-01-15\n")), "2020-01-15");
});

test("asks IANA for the TLD's server, then the registry for the domain", async () => {
  process.env.ANALYZER_WHOIS_CACHE = "off";
  whois.resetWhoisMemory();
  answers.set("old-site.test", "Domain Name: OLD-SITE.TEST\nCreation Date: 2012-05-06T00:00:00Z\n");
  queries.length = 0;
  const result = await whois.whoisLookup("www.old-site.test");
  assert.equal(result.status, "found");
  assert.equal(result.server, "whois.nic.test");
  assert.equal(new Date(result.createdOn).toISOString().slice(0, 10), "2012-05-06");
  assert.deepEqual(queries, ["test", "old-site.test"], "the TLD first, then the domain without www");
});

test("not found, no date and unsupported names are results, not errors", async () => {
  process.env.ANALYZER_WHOIS_CACHE = "off";
  answers.set("gone.test", "No match for \"GONE.TEST\".\n");
  answers.set("nodate.test", "Domain Name: NODATE.TEST\nRegistrar: Example\n");
  assert.equal((await whois.whoisLookup("gone.test")).status, "not_found");
  assert.equal((await whois.whoisLookup("nodate.test")).status, "no_date");
  assert.equal((await whois.whoisLookup("not a domain")).status, "unsupported");
  assert.equal((await whois.whoisLookup("localhost")).status, "unsupported");
});

test("a server that never answers is cut off by the time budget", async () => {
  process.env.ANALYZER_WHOIS_CACHE = "off";
  answers.set("slow.test", "HANG");
  const started = Date.now();
  const result = await whois.whoisLookup("slow.test", { budgetMs: 1200 });
  assert.equal(result.status, "error");
  assert.match(result.detail, /timed out|Out of time/);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
});

test("an oversized answer is cut at 64 KB, and the date at the top is still read", async () => {
  process.env.ANALYZER_WHOIS_CACHE = "off";
  answers.set("big.test", `Creation Date: 2018-02-03T00:00:00Z\n${"x".repeat(300_000)}`);
  const result = await whois.whoisLookup("big.test");
  assert.equal(result.status, "found");
});

test("results are cached in the database; a cached answer makes no network query", async () => {
  delete process.env.ANALYZER_WHOIS_CACHE;
  answers.set("cached.test", "Creation Date: 2016-06-06T00:00:00Z\n");
  const first = await whois.whoisLookup("cached.test");
  assert.equal(first.cached, false);
  queries.length = 0;
  const second = await whois.whoisLookup("cached.test");
  assert.equal(second.cached, true);
  assert.equal(second.createdOn, first.createdOn);
  assert.deepEqual(queries, [], "no query on a cache hit");
  const later = await whois.whoisLookup("cached.test", { now: Date.now() + 31 * 86_400_000 });
  assert.equal(later.cached, false, "expired after 30 days");
});

test("server names are screened: private, loopback, metadata and malformed names are refused", async () => {
  const saved = process.env.ANALYZER_WHOIS_SERVER;
  delete process.env.ANALYZER_WHOIS_SERVER;
  try {
    for (const name of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "localhost", "metadata.google.internal", "evil..name", "-bad.example", "a b.example"]) {
      await assert.rejects(whois.resolveServer(name), undefined, name);
    }
  } finally {
    process.env.ANALYZER_WHOIS_SERVER = saved;
  }
});

test("the test override is ignored outside tests", async () => {
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(whois.resolveServer("127.0.0.1"), "production never connects to a private address");
  } finally {
    process.env.NODE_ENV = "test";
  }
});
