// Regression test for the login → dashboard → billing → pricing → checkout
// flow, run against a real `next start` build and a throwaway database.
//
//     npm run test:auth-flow
//
// The original bug: a signed-in customer opened Pricing from Billing (or
// tried to upgrade from Free) and the page header showed "Log in", so they
// concluded the session had been dropped. The session was fine — the
// Pricing navbar simply never looked at it. The assertions marked
// [ORIGINAL BUG] fail on the pre-fix code.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { registerVerified, startMailSink } from "./lib/mail-sink.mjs";

const dataDir = await mkdtemp(path.join(tmpdir(), "aec-auth-flow-"));
const mail = await startMailSink();
const port = 3300 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const stamp = Date.now();
const password = "Str0ng-Password!";
let passed = 0;

function startServer() {
  return spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345",
        ...mail.env,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/pricing`);
      if (response.ok) return;
    } catch {
      // The server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the test server");
}

function check(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "a session cookie should be issued");
  const cookie = value.split(";", 1)[0];
  assert.match(cookie, /^aec_session=.+/, "cookie name should be consistent");
  return { cookie, raw: value };
}

async function request(pathname, options = {}, cookie) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${base}${pathname}`, { ...options, headers, redirect: "manual" });
}

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify(body),
});

async function signup(label) {
  const email = `auth-flow-${label}-${stamp}@example.test`;
  // Sign-up now confirms the address with an emailed code before any
  // session exists; registerVerified does both steps.
  const { cookie, raw } = await registerVerified({ base, mail, name: `Auth ${label}`, email, password });
  assert.match(cookie, /^aec_session=.+/, "cookie name should be consistent");
  return { email, cookie, raw };
}

async function login(email) {
  const res = await request("/api/auth/login", json({ email, password }));
  assert.equal(res.status, 200, "login should succeed");
  return sessionCookie(res);
}

function db() {
  const handle = new DatabaseSync(path.join(dataDir, "app.db"));
  handle.exec("PRAGMA busy_timeout = 5000");
  return handle;
}

const loginRedirect = (res) => decodeURIComponent(res.headers.get("location") ?? "");

const server = startServer();

try {
  await waitForServer();
  {
    // Rupee pricing, as an operator selling in INR sets in Admin → Website currency.
    const db = new DatabaseSync(path.join(dataDir, "app.db"));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES ('site.currency', 'INR', ?, 'test')").run(Date.now());
    db.close();
  }

  console.log("auth flow regression");

  /* 1 ─ logged-out visitor */
  await check("logged-out visitor sees the login form", async () => {
    const res = await request("/login");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /name="password"/);
  });

  await check("anonymous billing redirects to login with its return path", async () => {
    const res = await request("/dashboard/billing");
    assert.equal(res.status, 307);
    assert.match(loginRedirect(res), /^\/login\?next=\/dashboard\/billing$/);
  });

  await check("pricing is public and offers Log in to anonymous visitors", async () => {
    const res = await request("/pricing");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /href="\/login"/);
  });

  await check("anonymous checkout is 401, not 403", async () => {
    const res = await request("/api/checkout/order", json({ planId: "basic" }));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "UNAUTHENTICATED");
  });

  /* 2 ─ login establishes a session */
  const alice = await signup("alice");
  const aliceLogin = await login(alice.email);
  const cookie = aliceLogin.cookie;

  await check("login cookie is HttpOnly, SameSite=Lax, Path=/ and persistent", () => {
    const raw = aliceLogin.raw;
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    assert.match(raw, /Path=\//i);
    const expires = Date.parse(/Expires=([^;]+)/i.exec(raw)?.[1] ?? "");
    // A persistent (not session-only) cookie is what survives a browser
    // restart; it should run for the full 30-day TTL.
    assert.ok(expires - Date.now() > 29 * 24 * 3600 * 1000, "cookie should persist ~30 days");
  });

  /* 3 + 4 + 6 ─ every page in the flow, twice (initial load and refresh) */
  for (const page of ["/dashboard", "/dashboard/billing", "/pricing", "/pricing?plan=basic", "/dashboard/settings"]) {
    await check(`signed-in ${page} loads and survives a refresh`, async () => {
      for (let i = 0; i < 2; i += 1) {
        const res = await request(page, {}, cookie);
        assert.equal(res.status, 200, `${page} attempt ${i + 1}`);
        assert.equal(res.headers.get("set-cookie"), null, "navigation must never clear the cookie");
      }
    });
  }

  await check("[ORIGINAL BUG] signed-in Pricing header shows Dashboard, not Log in", async () => {
    const html = await (await request("/pricing", {}, cookie)).text();
    assert.match(html, /href="\/dashboard"/, "signed-in navbar should link to the dashboard");
    assert.doesNotMatch(html, /href="\/login"/, "signed-in navbar must not offer Log in");
  });

  await check("signed-in client navigation (RSC) to Pricing keeps the session", async () => {
    const res = await request("/pricing?_rsc=test", { headers: { RSC: "1" } }, cookie);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.doesNotMatch(body, /"href":"\/login"/);
    // The session is still valid afterwards.
    assert.equal((await request("/dashboard/billing", {}, cookie)).status, 200);
  });

  /* 5 ─ select a paid plan and proceed to checkout */
  await check("selecting a paid plan reaches checkout authenticated", async () => {
    // A fresh install has no gateway enabled: the answer must be "payments
    // unavailable" (503), never "log in" (401).
    const res = await request("/api/checkout/order", json({ planId: "basic", billing: { name: "Test Buyer", email: "buyer@example.test", country: "IN", phone: "98765 43210" } }), cookie);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "PAYMENTS_UNCONFIGURED");
    assert.equal((await request("/dashboard/billing", {}, cookie)).status, 200);
  });

  await check("server rejects a plan id it does not sell", async () => {
    const res = await request("/api/checkout/order", json({ planId: "free" }), cookie);
    assert.equal(res.status, 400);
  });

  await check("anonymous paid-plan CTA returns to that plan's checkout after signup", async () => {
    const html = await (await request("/pricing")).text();
    assert.match(html, /\/signup\?next=%2Fcheckout%3Fplan%3Dbasic/);
  });

  /* 10 ─ CSRF and authorization */
  await check("cross-origin mutation is rejected with 403", async () => {
    const res = await request(
      "/api/auth/login",
      { ...json({ email: alice.email, password }), headers: { "content-type": "application/json", origin: "https://attacker.invalid" } },
    );
    assert.equal(res.status, 403);
    // …and it did not cost the real session anything.
    assert.equal((await request("/dashboard", {}, cookie)).status, 200);
  });

  await check("signed-in non-admin gets 404 from the admin panel, session intact", async () => {
    assert.equal((await request("/admin", {}, cookie)).status, 404);
    assert.equal((await request("/dashboard", {}, cookie)).status, 200);
  });

  await check("admin API answers 403 (not 401) to a signed-in customer", async () => {
    const res = await request("/api/admin/plans/basic", { method: "PATCH", headers: { "content-type": "application/json", origin: base }, body: "{}" }, cookie);
    assert.equal(res.status, 403);
  });

  /* 11 ─ another user's billing and reports */
  const bob = await signup("bob");
  await check("users cannot read each other's reports or invoices", async () => {
    const handle = db();
    const aliceId = handle.prepare("SELECT id FROM users WHERE email = ?").get(alice.email).id;
    const now = Date.now();
    handle.prepare("INSERT INTO websites (id, user_id, domain, created_at) VALUES (?, ?, ?, ?)")
      .run("web_test_alice", aliceId, "alice.example", now);
    handle.prepare(`INSERT INTO reports (id, ref, user_id, website_id, url, domain, state, plan_id, plan_name,
        engine_version, started_at, created_at) VALUES (?, 'RPT-TEST01', ?, 'web_test_alice',
        'https://alice.example', 'alice.example', 'complete', 'free', 'Free', 'test', ?, ?)`)
      .run("rep_test_alice", aliceId, now, now);
    handle.prepare(`INSERT INTO payments (id, user_id, plan_id, amount_paise, status, mode, gateway_order_id,
        created_at, updated_at) VALUES ('pay_test_alice', ?, 'basic', 39900, 'paid', 'mock', 'order_test_alice', ?, ?)`)
      .run(aliceId, now, now);
    handle.prepare(`INSERT INTO invoices (id, number, user_id, payment_id, billing_name, billing_email, plan_name,
        amount_paise, period_start, period_end, issued_at) VALUES ('inv_test_alice', 'INV-TEST-1', ?,
        'pay_test_alice', 'Alice', ?, 'Basic', 39900, ?, ?, ?)`)
      .run(aliceId, alice.email, now, now + 1, now);
    handle.close();

    assert.equal((await request("/api/reports/rep_test_alice", {}, cookie)).status, 200, "owner reads report");
    assert.equal((await request("/api/reports/rep_test_alice", {}, bob.cookie)).status, 404);
    assert.equal((await request("/dashboard/reports/rep_test_alice", {}, bob.cookie)).status, 404);
    assert.equal((await request("/dashboard/billing/invoices/inv_test_alice", {}, cookie)).status, 200, "owner reads invoice");
    assert.equal((await request("/dashboard/billing/invoices/inv_test_alice", {}, bob.cookie)).status, 404);
    const del = await request("/api/reports/rep_test_alice", { method: "DELETE", headers: { origin: base } }, bob.cookie);
    assert.equal(del.status, 404);
    assert.equal((await request("/api/reports/rep_test_alice", {}, cookie)).status, 200, "still there for the owner");
  });

  /* 9 ─ expired sessions */
  await check("an expired session is rejected and the return path is kept", async () => {
    const { cookie: doomed } = await login(alice.email);
    assert.equal((await request("/dashboard/billing", {}, doomed)).status, 200);
    const handle = db();
    // Expire only the newest session (the one just issued).
    handle.prepare(
      "UPDATE sessions SET expires_at = ? WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)",
    ).run(Date.now() - 1000);
    handle.close();

    const page = await request("/dashboard/billing?tab=history", {}, doomed);
    assert.equal(page.status, 307);
    assert.equal(loginRedirect(page), "/login?next=/dashboard/billing?tab=history");

    const api = await request("/api/checkout/order", json({ planId: "basic" }), doomed);
    assert.equal(api.status, 401);

    // Other devices are unaffected by one session expiring.
    assert.equal((await request("/dashboard", {}, cookie)).status, 200);
  });

  await check("a forged path header cannot turn the login return into an open redirect", async () => {
    const res = await request("/dashboard", { headers: { "x-aec-path": "//attacker.invalid" } }, "aec_session=forged");
    assert.equal(res.status, 307);
    assert.equal(loginRedirect(res), "/login?next=/dashboard");
  });

  /* 8 ─ logout */
  await check("logout revokes the session server-side and expires the cookie", async () => {
    const res = await request("/api/auth/logout", { method: "POST", headers: { origin: base } }, cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /aec_session=;.*Max-Age=0/i);

    const page = await request("/dashboard/billing", {}, cookie);
    assert.equal(page.status, 307, "replaying the old cookie must not reach billing");
    assert.equal((await request("/api/reports/rep_test_alice", {}, cookie)).status, 401);
    assert.equal((await request("/api/checkout/order", json({ planId: "basic" }), cookie)).status, 401);
    // Bob's session is untouched by Alice logging out.
    assert.equal((await request("/dashboard", {}, bob.cookie)).status, 200);
  });

  console.log(`auth flow regression: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close();
  await rm(dataDir, { recursive: true, force: true });
}
