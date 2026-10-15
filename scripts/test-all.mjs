// The whole regression run, one command:
//
//     npm run test:all
//
// Type check, lint, production build, then every test suite one after
// another (the HTTP suites start their own server on the build). Prints a
// table at the end: passed, failed, or blocked — blocked means a
// prerequisite is missing on this machine (named in the table), not that
// the suite was quietly skipped. Exits non-zero if anything failed.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findChromium } from "./lib/chromium.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const bin = (name) => path.join(root, "node_modules", ".bin", name);

const browserProblem = findChromium().problem ?? null;

const steps = [
  ["type check", bin("tsc"), ["--noEmit", "-p", "."]],
  ["lint", bin("next"), ["lint"]],
  ["production build", bin("next"), ["build"]],
  ["verify (core regression)", node, ["scripts/verify.mjs"]],
  ["analysis engine", node, ["scripts/analysis-test.mjs"]],
  ["analyzer framework", node, ["scripts/analyzer-framework-test.mjs"]],
  ["analyzers (47, fixtures)", node, ["scripts/analyzers-unit-test.mjs"]],
  ["whois", node, ["--test", "scripts/whois-test.mjs"]],
  ["prediction model", node, ["--test", "--test-concurrency=1", "scripts/ml-test.mjs"]],
  ["smart insights", node, ["--test", "--test-concurrency=1", "scripts/insights-test.mjs"]],
  ["phase 7 coverage", node, ["scripts/phase7-test.mjs"]],
  ["auth flow", node, ["scripts/auth-flow-test.mjs"]],
  ["profile", node, ["scripts/profile-test.mjs"]],
  ["checkout", node, ["scripts/checkout-test.mjs"]],
  ["login & email codes", node, ["scripts/otp-test.mjs"]],
  ["pricing & currency", node, ["scripts/pricing-test.mjs"]],
  ["monthly & yearly billing", node, ["scripts/billing-cycle-test.mjs"]],
  ["live chat", node, ["scripts/chat-test.mjs"]],
  ["payment alerts", node, ["scripts/alerts-test.mjs"]],
  ["scheduled jobs", node, ["scripts/scheduler-test.mjs"]],
  ["analytics", node, ["scripts/analytics-test.mjs"]],
  ["homepage", node, ["scripts/homepage-test.mjs"]],
  ["smtp", node, ["scripts/smtp-test.mjs"]],
  ["prediction model over HTTP", node, ["scripts/ml-http-test.mjs"]],
  ["smart insights over HTTP", node, ["scripts/insights-http-test.mjs"]],
  ["usage limits", node, ["scripts/limits-test.mjs"]],
  ["report & PDF", node, ["scripts/report-test.mjs"], browserProblem],
];

function runStep(cmd, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    const child = spawn(cmd, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
  });
}

const results = [];
for (const [name, cmd, args, blocked] of steps) {
  if (blocked) {
    results.push({ name, status: "BLOCKED", note: blocked });
    console.log(`… ${name}: BLOCKED — ${blocked}`);
    continue;
  }
  process.stdout.write(`… ${name} `);
  const { code, out, ms } = await runStep(cmd, args);
  const tally = out.match(/(\d+) passed, (\d+) failed/) ?? out.match(/passed \((\d+) checks?\)/) ?? out.match(/# pass (\d+)/) ?? out.match(/^(\d+) passed$/m);
  const note = tally ? tally[0].replace(/^# /, "") : "";
  results.push({ name, status: code === 0 ? "PASS" : "FAIL", note, ms, out });
  console.log(`${code === 0 ? "PASS" : "FAIL"} ${note} (${Math.round(ms / 1000)} s)`);
}

console.log("\n──────────────────────────────────────────────");
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name.padEnd(32)} ${r.note ?? ""}`);
const failed = results.filter((r) => r.status === "FAIL");
for (const r of failed) {
  console.log(`\n── ${r.name}: last lines ──`);
  console.log(r.out.trim().split("\n").slice(-25).join("\n"));
}
console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "BLOCKED").length} blocked`);
process.exit(failed.length ? 1 : 0);
