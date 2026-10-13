// Regression tests for the checkout page and its order API, against a real
// `next start` build (production mode: the payment simulator is off) and a
// throwaway data directory.
//
//     npm run test:checkout
//
// The full pay-and-activate path (gateway verification, duplicate
// confirmation, cancel-and-retry, invoice details) is covered at module
// level in `npm run verify`, because production mode — correctly — refuses
// to settle simulated payments and no real gateway is reachable in CI.

import strictAssert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { registerVerified, startMailSink } from "./lib/mail-sink.mjs";

const dataDir = await mkdtemp(path.join(tmpdir(), "aec-checkout-"));
const mail = await startMailSink();
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = { email: `admin-${stamp}@example.test`, password: "Adm1n-Password!" };
const DUMMY_SECRET = `dummy-secret-${stamp}-never-in-html`;
let passed = 0;

// HTML assertions: React separates adjacent text with <!-- --> markers, so
// flatten them first, and keep failure messages short.
const flat = (html) => String(html).replace(/<!-- -->/g, "");
const assert = Object.assign((...args) => strictAssert(...args), strictAssert, {
  match(html, re, message) {
    if (!re.test(flat(html))) strictAssert.fail(message ?? `expected the page to match ${re}`);
  },
  doesNotMatch(html, re, message) {
    const found = flat(html).match(re);
    if (found) strictAssert.fail(message ?? `expected the page not to match ${re}; found "${found[0].slice(0, 80)}"`);
  },
});

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345",
    ADMIN_EMAIL: admin.email,
    ADMIN_PASSWORD: admin.password,
    PAYMENTS_MODE: "mock", // must be ignored in production
    ...mail.env,
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/pricing`)).ok) return;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for the test server");
}

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function request(pathname, options = {}, cookie) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (options.method && options.method !== "GET" && !headers.has("origin")) headers.set("origin", base);
  return fetch(`${base}${pathname}`, { ...options, headers, redirect: "manual" });
}

const post = (body, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const patch = (body) => ({ ...post(body), method: "PATCH" });

const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";", 1)[0];
const where = (res) => decodeURIComponent(res.headers.get("location") ?? "");
const billing = { name: "Ananya Rao", email: "ananya@example.test", country: "IN", phone: "98765 43210" };
const attempt = () => crypto.randomUUID();

function payments() {
  const db = new DatabaseSync(path.join(dataDir, "app.db"));
  const rows = db.prepare("SELECT * FROM payments").all();
  db.close();
  return rows;
}

try {
  await waitForServer();
  console.log("checkout regression");
  {
    // This suite exercises rupee checkout: set the website currency to INR
    // (Admin → Website currency), as an operator selling in INR would.
    const db = new DatabaseSync(path.join(dataDir, "app.db"));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES ('site.currency', 'INR', ?, 'test')").run(Date.now());
    db.close();
  }

  /* 1 + 2 ─ authentication and the selected plan */
  await check("logged-out visitors are sent to log in, keeping the plan", async () => {
    const res = await request("/checkout?plan=basic");
    assert.equal(res.status, 307);
    assert.equal(where(res), "/login?next=/checkout?plan=basic");
  });

  await check("the pricing page's paid CTA returns to checkout after signup", async () => {
    const html = await (await request("/pricing")).text();
    assert.match(html, /\/signup\?next=%2Fcheckout%3Fplan%3Dbasic/);
    assert.match(html, /\/signup\?next=%2Fcheckout%3Fplan%3Dpro/);
  });

  // Signing up from a paid CTA: the plan travels with the pending sign-up
  // and the verify step sends the new customer straight to that checkout.
  const verified = await registerVerified({
    base, mail, name: "Ananya", email: `buyer-${stamp}@example.test`, password, next: "/checkout?plan=basic",
  });
  const cookie = verified.cookie;
  await check("after confirming the email code, a new buyer lands on the plan they picked", async () => {
    assert.equal(verified.body.redirectTo, "/checkout?plan=basic");
  });

  await check("after authenticating, the login page forwards to that exact checkout", async () => {
    const res = await request(`/login?next=${encodeURIComponent("/checkout?plan=basic")}`, {}, cookie);
    assert.equal(res.status, 307);
    assert.equal(where(res), "/checkout?plan=basic");
  });

  /* 3 + 7 ─ checkout opens; no gateway → clear unavailable state */
  await check("an authenticated user opens checkout with the server's plan and price", async () => {
    const res = await request("/checkout?plan=basic&price=1&amount=100", {}, cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Complete your purchase/);
    assert.match(html, /Basic plan/);
    assert.match(html, /₹399/);
    assert.doesNotMatch(html, /₹1[^0-9]/, "query-string price is ignored");
    assert.match(html, /won(&#x27;|')t be charged again automatically/);
  });

  await check("with no gateway enabled, checkout says so and offers no Pay button", async () => {
    const html = await (await request("/checkout?plan=basic", {}, cookie)).text();
    assert.match(html, /Checkout is temporarily unavailable/);
    assert.doesNotMatch(html, />Pay ₹/);
    // PAYMENTS_MODE=mock is set on this server and must not leak into production.
    assert.doesNotMatch(html, /Test mode/);
    const pricing = await (await request("/pricing", {}, cookie)).text();
    assert.match(pricing, /Purchase unavailable/);
  });

  /* 9 ─ invalid or disabled plans */
  await check("free, unknown and malformed plans are refused", async () => {
    for (const plan of ["free", "enterprise", "", "../admin", "basic%00"]) {
      const html = await (await request(`/checkout?plan=${plan}`, {}, cookie)).text();
      assert.match(html, /That plan isn(&#x27;|')t available/, plan);
    }
    for (const planId of ["free", "enterprise", "", 42]) {
      const res = await request("/api/checkout/order", post({ planId, billing, attemptId: attempt() }), cookie);
      assert.equal(res.status, 400, String(planId));
    }
  });

  const adminCookie = cookieOf(await request("/api/auth/login", post({ email: admin.email, password: admin.password })));
  await check("a plan an admin has switched off cannot be bought", async () => {
    const off = await request("/api/admin/plans/pro", patch({ active: false }), adminCookie);
    assert.equal(off.status, 200, await off.clone().text());
    assert.match(await (await request("/checkout?plan=pro", {}, cookie)).text(), /That plan isn(&#x27;|')t available/);
    assert.equal((await request("/api/checkout/order", post({ planId: "pro", billing, attemptId: attempt() }), cookie)).status, 400);
    const on = await request("/api/admin/plans/pro", patch({ active: true }), adminCookie);
    assert.equal(on.status, 200);
  });

  /* 4 ─ billing details */
  await check("billing name, email and phone are validated on the server", async () => {
    const cases = [
      [{ ...billing, name: "" }, "name"],
      [{ ...billing, name: "1234" }, "name"],
      [{ ...billing, email: "not-an-email" }, "email"],
      [{ ...billing, phone: "" }, "phone"],
      [{ ...billing, phone: "12345" }, "phone"],
      [{ ...billing, country: "XX" }, "country"],
      [undefined, "name"],
    ];
    for (const [input, field] of cases) {
      const res = await request("/api/checkout/order", post({ planId: "basic", billing: input, attemptId: attempt() }), cookie);
      assert.equal(res.status, 400, JSON.stringify(input));
      const body = await res.json();
      assert.ok(body.fields?.[field], `${field} error for ${JSON.stringify(input)}`);
    }
    assert.equal(payments().length, 0, "no order was opened for invalid details");
  });

  await check("valid details with no gateway get 'unavailable', not an order", async () => {
    const res = await request("/api/checkout/order", post({ planId: "basic", billing, attemptId: attempt() }), cookie);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "PAYMENTS_UNCONFIGURED");
  });

  await check("a malformed purchase-attempt id is refused", async () => {
    const res = await request("/api/checkout/order", post({ planId: "basic", billing, attemptId: "x'; DROP TABLE payments;--" }), cookie);
    assert.equal(res.status, 400);
  });

  /* 5 + 6 ─ only enabled, configured gateways */
  await check("a half-configured gateway cannot be switched on", async () => {
    const res = await request("/api/admin/gateways/cashfree", patch({ values: { appId: "only-the-id" }, enabled: true, environment: "sandbox" }), adminCookie);
    const html = await (await request("/checkout?plan=basic", {}, cookie)).text();
    assert.doesNotMatch(html, /Cashfree/, `status ${res.status}`);
  });

  await check("only the enabled, configured gateway is listed — without its secrets", async () => {
    const res = await request(
      "/api/admin/gateways/razorpay",
      patch({ values: { keyId: "rzp_test_dummykey", keySecret: DUMMY_SECRET, webhookSecret: DUMMY_SECRET }, enabled: true, environment: "sandbox" }),
      adminCookie,
    );
    assert.equal(res.status, 200, await res.clone().text());
    const html = await (await request("/checkout?plan=basic", {}, cookie)).text();
    assert.match(html, /Razorpay/);
    assert.match(html, /Sandbox/);
    assert.match(html, /UPI · Cards · Net banking · Wallets/);
    assert.doesNotMatch(html, /Cashfree|PayPal/);
    assert.doesNotMatch(html, /Checkout is temporarily unavailable/);
    assert.match(html, /Pay ₹399 with Razorpay/);
    strictAssert.ok(!html.includes(DUMMY_SECRET), "no secret in the page");
    const pricing = await (await request("/pricing", {}, cookie)).text();
    assert.match(pricing, /href="\/checkout\?plan=basic"/);
  });

  await check("a disabled gateway is refused even if named in the request", async () => {
    const res = await request("/api/checkout/order", post({ planId: "basic", gateway: "paypal", billing, attemptId: attempt() }), cookie);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "GATEWAY_DISABLED");
  });

  /* 8 + 10 ─ tampering and failure */
  await check("browser-supplied prices are ignored; a failed gateway call grants nothing", async () => {
    const res = await request(
      "/api/checkout/order",
      post({ planId: "basic", gateway: "razorpay", billing, attemptId: attempt(), amountPaise: 100, amount: 1, price: 1, total: 1 }),
      cookie,
    );
    // The dummy key cannot open a real Razorpay order from here, so the
    // gateway refuses — and nothing must be recorded or activated.
    const body = await res.json();
    if (res.ok) {
      assert.equal(body.amountPaise, 39900, "server price, not the browser's");
      assert.equal(body.currency, "INR");
    } else {
      assert.equal(body.code, "PAYMENT_FAILED");
      assert.equal(payments().length, 0, "no order row for a refused gateway call");
    }
    for (const row of payments()) assert.equal(row.amount_paise, 39900);
    // The currency is the website's (INR here). A browser that claims USD is
    // treated as a stale or tampered page and refused — never charged in INR
    // without the customer seeing it.
    const usd = await request(
      "/api/checkout/order",
      post({ planId: "basic", gateway: "razorpay", billing, attemptId: attempt(), currency: "USD", amountPaise: 100 }),
      cookie,
    );
    assert.equal((await usd.json()).code, "PRICE_CHANGED");
    for (const row of payments()) assert.equal(row.currency, "INR");
    const billingPage = await (await request("/dashboard/billing", {}, cookie)).text();
    assert.doesNotMatch(billingPage, /Basic is active|Your plan: Basic/);
  });

  /* order ownership */
  await check("the payment status page never shows someone else's order", async () => {
    assert.equal((await request("/checkout/success?order=order_does_not_exist", {}, cookie)).status, 404);
    assert.equal((await request("/checkout/success", {}, cookie)).status, 404);
  });

  /* CSRF */
  await check("checkout orders must come from this site", async () => {
    const res = await request("/api/checkout/order", post({ planId: "basic", billing, attemptId: attempt() }, { origin: "https://attacker.invalid" }), cookie);
    assert.equal(res.status, 403);
  });

  /* 15 ─ logout and expiry */
  await check("an expired session is sent back to log in, plan preserved", async () => {
    const second = cookieOf(await request("/api/auth/login", post({ email: `buyer-${stamp}@example.test`, password })));
    const db = new DatabaseSync(path.join(dataDir, "app.db"));
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)").run(Date.now() - 1);
    db.close();
    const res = await request("/checkout?plan=pro", {}, second);
    assert.equal(res.status, 307);
    assert.equal(where(res), "/login?next=/checkout?plan=pro");
    assert.equal((await request("/api/checkout/order", post({ planId: "pro", billing, attemptId: attempt() }), second)).status, 401);
  });

  await check("after logout, checkout and its API are closed", async () => {
    assert.equal((await request("/api/auth/logout", { method: "POST" }, cookie)).status, 200);
    assert.equal((await request("/checkout?plan=basic", {}, cookie)).status, 307);
    assert.equal((await request("/api/checkout/order", post({ planId: "basic", billing, attemptId: attempt() }), cookie)).status, 401);
  });

  console.log(`checkout regression: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close();
  await rm(dataDir, { recursive: true, force: true });
}
