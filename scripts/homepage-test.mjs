// Homepage redesign regression.
//
//     npm run build && node scripts/homepage-test.mjs
//
// Starts the production build on a fresh database and checks that the
// redesigned homepage shows the same plans, prices and plan buttons as
// /pricing (both read the live catalogue), that a domain still goes
// through /start exactly as before, that the FAQ is the last section,
// and that the shared navigation bar and footer are on every page.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "aec-home-"));
const port = 5600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", DATA_DIR: dataDir, AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345", CHECKOUT_ALERTS_BACKGROUND: "off" };
for (const name of ["PAYMENTS_MODE", "ADMIN_EMAIL", "ADMIN_PASSWORD"]) delete env[name];
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], { cwd: projectRoot, env, stdio: "ignore" });

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
const get = async (p) => {
  const res = await fetch(`${base}${p}`, { redirect: "manual", headers: { "user-agent": "homepage-test" } });
  return { status: res.status, location: res.headers.get("location"), text: (await res.text()).replace(/<!-- -->/g, "") };
};
const planLinks = (html) => [...new Set([...html.matchAll(/href="(\/signup\?next=[^"]*)"/g)].map((m) => m[1]))].sort();
const priceText = (html) => [...html.matchAll(/>(₹|\$)([0-9][0-9,.]*)</g)].map((m) => m[1] + m[2]);

console.log("homepage redesign");
try {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  await check("1 the homepage has the shared navigation bar and footer around the new sections", async () => {
    const { status, text } = await get("/");
    assert.equal(status, 200);
    assert.match(text, /<nav aria-label="Main"/, "navigation bar");
    assert.match(text, /<footer/, "footer");
    const ids = [...text.matchAll(/<section[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["top", "features", "report", "process", "pricing", "guides", "faq"]);
    assert.ok(text.indexOf('id="faq"') < text.indexOf("<footer"), "the FAQ is the last section before the footer");
  });

  await check("2 every plan card shows the catalogue's own price in the website currency, like /pricing", async () => {
    const db = new DatabaseSync(path.join(dataDir, "app.db"));
    const plans = db.prepare("SELECT id, name, amount_paise, usd_amount_cents FROM plans WHERE active = 1 ORDER BY sort_order").all();
    // Give Basic a USD price so both currencies have something to show.
    db.prepare("UPDATE plans SET usd_amount_cents = 599 WHERE id = 'basic'").run();
    const setSite = (code) => db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES ('site.currency', ?, ?, 'test')").run(code, Date.now());
    assert.ok(plans.length >= 3);
    for (const [code, field, sym, other] of [["INR", "amount_paise", "₹", "$"], ["USD", "usd_amount_cents", "$", "₹"]]) {
      setSite(code);
      const fresh = db.prepare(`SELECT name, ${field} AS amount FROM plans WHERE active = 1 ORDER BY sort_order`).all();
      const home = (await get("/")).text;
      const pricing = (await get("/pricing")).text;
      for (const plan of fresh) {
        assert.ok(home.includes(`>${plan.name}<`), `${plan.name} card on the homepage`);
        if (plan.amount === null) continue;
        const major = (plan.amount / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
        assert.ok(priceText(home).includes(`${sym}${major}`), `${plan.name} ${sym}${major} on the homepage`);
      }
      assert.deepEqual(priceText(home), priceText(pricing).slice(0, priceText(home).length), "same prices as /pricing");
      assert.ok(!priceText(home).some((p) => p.startsWith(other)), `no ${other} price when the site is in ${code}`);
      assert.doesNotMatch(home, /aria-label="Currency"/, "no currency switcher");
      assert.deepEqual(planLinks(home), planLinks(pricing), "same plan buttons as /pricing");
    }
    setSite("INR");
    db.close();
  });

  await check("3 each plan button carries its own plan id to sign-up and checkout", async () => {
    const links = planLinks((await get("/")).text).map((l) => l.replace(/&amp;/g, "&"));
    assert.ok(links.includes("/signup?next=%2Fcheckout%3Fplan%3Dbasic&plan=basic"));
    assert.ok(links.includes("/signup?next=%2Fcheckout%3Fplan%3Dpro&plan=pro"));
    assert.ok(links.includes("/signup?next=%2Fpricing%3Fplan%3Dfree&plan=free"));
    assert.ok(links.every((l) => !l.includes("currency")), "no currency in the links: checkout uses the website currency");
  });

  await check("4 the domain form still hands off to /start, which routes as before", async () => {
    const home = (await get("/")).text;
    assert.match(home, /id="url-lg"/, "the original form is on the page");
    const r = await get("/start?url=https%3A%2F%2Fwww.Example.com%2Fpath");
    assert.equal(r.status, 307);
    assert.equal(decodeURIComponent(r.location), "/signup?next=/dashboard/checker?url=example.com&url=example.com");
    const bad = await get("/start?url=not%20a%20domain");
    assert.equal(decodeURIComponent(bad.location), "/signup?next=/dashboard/checker");
  });

  await check("5 other pages keep their navigation and footer", async () => {
    for (const p of ["/pricing", "/team"]) {
      const { status, text } = await get(p);
      assert.equal(status, 200, p);
      assert.match(text, /<footer/, `${p} footer`);
      assert.match(text, /<nav aria-label="Main"/, `${p} navigation bar`);
    }
  });

  await check("6 guides and FAQ are real content, linked from the shared footer", async () => {
    const home = (await get("/")).text;
    for (const id of ["guide-rejections", "guide-required-pages", "guide-ads-txt", "guide-content"]) assert.match(home, new RegExp(`id="${id}"`));
    assert.match(home, /f08c47fec0942fa0/, "the real AdSense ads.txt line");
    const footer = (await get("/pricing")).text;
    assert.match(footer, /href="\/#guide-ads-txt"/);
    assert.match(footer, /href="\/#report"/);
  });

  console.log(`homepage redesign: passed (${passed} checks)`);
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
