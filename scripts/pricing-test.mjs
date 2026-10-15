// INR + USD pricing, currency-aware checkout and payments.
//
//     npm run build && node scripts/pricing-test.mjs
//
// Part A runs the real lib/ modules (compiled to CommonJS, as verify.mjs
// does) against the real Razorpay / Cashfree / PayPal adapters, with
// `fetch` answered by a stand-in for each provider's API — so the exact
// order bodies the adapters would send are checked, and verification is
// exercised with genuine Razorpay signatures and PayPal capture payloads.
//
// Part B starts the production build on the same database and checks the
// admin pricing API, the pricing and checkout pages, the order route's
// refusals, and the billing/admin tables.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedServerEnv } from "./lib/server-env.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(path.join(tmpdir(), "aec-pricing-"));
const outDir = path.join(workDir, "build");
const dataDir = path.join(workDir, "data");
mkdirSync(dataDir, { recursive: true });

const SECRETS = {
  AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345",
  CREDENTIALS_SECRET: randomBytes(48).toString("base64"),
};
Object.assign(process.env, SECRETS, { DATA_DIR: dataDir, NODE_ENV: "development" });
for (const name of [
  "PAYMENTS_MODE", "ADMIN_EMAIL", "ADMIN_PASSWORD",
  "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
  "CASHFREE_APP_ID", "CASHFREE_SECRET_KEY", "CASHFREE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID",
]) delete process.env[name];

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    // Keep failures readable: a regex miss against a whole page is noise.
    if (error && typeof error.message === "string" && error.message.length > 400) {
      error.message = `${error.message.slice(0, 300)}…`;
      delete error.actual;
    }
    console.log(`  ✗ ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function compileLib() {
  const tsconfig = path.join(workDir, "tsconfig.json");
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      target: "es2022", module: "commonjs", moduleResolution: "node", esModuleInterop: true,
      skipLibCheck: true, strict: true, outDir, rootDir: projectRoot, baseUrl: projectRoot,
      paths: { "@/*": ["./*"] }, types: ["node"],
      typeRoots: [path.join(projectRoot, "node_modules", "@types")],
    },
    include: [path.join(projectRoot, "lib/**/*.ts")],
  }));
  execFileSync(path.join(projectRoot, "node_modules", ".bin", "tsc"), ["-p", tsconfig], { stdio: "inherit" });
  const nodeModules = path.join(outDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(outDir, path.join(nodeModules, "@"), "dir");
  for (const pkg of ["libphonenumber-js", "sharp", "nodemailer", "cheerio"]) {
    try { symlinkSync(path.join(projectRoot, "node_modules", pkg), path.join(nodeModules, pkg), "dir"); } catch { /* optional */ }
  }
}

/* ── a stand-in for the three providers' APIs ──────────────────── */

const realFetch = globalThis.fetch;
const calls = [];
const scenario = { razorpayPayment: null, paypalCapture: null };
let seq = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
  calls.push({ url, method: init.method ?? "GET", body });

  if (url === "https://api.razorpay.com/v1/orders") {
    return json(200, { id: `order_rzp_${++seq}`, amount: body.amount, currency: body.currency });
  }
  if (url.startsWith("https://api.razorpay.com/v1/payments/")) {
    return json(200, scenario.razorpayPayment);
  }
  if (url === "https://sandbox.cashfree.com/pg/orders") {
    return json(200, { order_id: body.order_id, payment_session_id: `session_${++seq}` });
  }
  if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: "pp_token", expires_in: 3600 });
  if (url.endsWith("/v2/checkout/orders")) {
    return json(201, { id: `PP${++seq}`, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://paypal.test/approve" }] });
  }
  if (/\/v2\/checkout\/orders\/[^/]+\/capture$/.test(url)) return json(201, scenario.paypalCapture);
  return json(404, { message: `no stub for ${url}` });
};

const ordersTo = (host) => calls.filter((c) => c.method === "POST" && c.url.includes(host) && /orders$/.test(c.url));
const lastBodyTo = (host) => ordersTo(host).at(-1)?.body;

compileLib();
const req = createRequire(path.join(outDir, "lib", "x.js"));
const L = (m) => req(path.join(outDir, "lib", m));
const accounts = L("db/accounts.js");
const billing = L("db/billing.js");
const { hashPasswordSync } = L("auth/password.js");
const catalogue = L("plan-catalogue.js");
const payments = L("payments/index.js");
const money = L("money.js");
const site = L("site-currency.js");

console.log("pricing & currency regression");

/* ════════════════════ Part A — modules ════════════════════ */

const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = accounts.createUser({ name: "Admin", email: `pa-admin-${stamp}@example.test`, passwordHash: hashPasswordSync(password), role: "admin" });
const buyer = accounts.createUser({ name: "Buyer", email: `pa-buyer-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
const browser = accounts.createUser({ name: "Browser", email: `pa-browser-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
const actor = { id: admin.id, email: admin.email };
const billingDetails = { name: "Asha Buyer", email: "asha@example.test", phone: "+919876543210", country: "IN" };

const open = (planId, currency, gateway) =>
  payments.startCheckout({
    userId: buyer.id, plan: catalogue.requirePlan(planId), currency, gateway,
    customerName: "Asha", customerEmail: "asha@example.test", billing: billingDetails,
    returnUrl: "http://127.0.0.1/dashboard/billing/return", idempotencyKey: randomUUID(),
  });

await check("A1 money: decimal strings parse to integer minor units; nothing else does", () => {
  assert.equal(money.parseMajorToMinor("399"), 39900);
  assert.equal(money.parseMajorToMinor("5.99"), 599);
  assert.equal(money.parseMajorToMinor("0.1"), 10);
  assert.equal(money.parseMajorToMinor("1,299.5"), 129950);
  for (const bad of ["-5", "5.999", "1e3", "abc", "", " ", "5.", ".5", null, undefined, NaN, Infinity]) {
    assert.equal(money.parseMajorToMinor(bad), null, `rejects ${String(bad)}`);
  }
  assert.equal(money.minorToDecimalString(599), "5.99");
  assert.equal(money.minorToDecimalString(39900), "399.00");
  assert.equal(money.formatMoney(599, "USD"), "$5.99");
  assert.equal(money.formatMoney(39900, "INR"), "₹399");
  assert.equal(money.formatMoneyExact(39900, "INR"), "₹399.00");
});

await check("A2 existing INR prices are untouched; USD starts unset; Free is free in both", () => {
  const plans = Object.fromEntries(catalogue.listPlans().map((p) => [p.id, p]));
  assert.equal(plans.basic.amountPaise, 39900);
  assert.equal(plans.pro.amountPaise, 99900);
  assert.equal(plans.basic.usdAmountCents, null, "no invented dollar price");
  assert.equal(plans.free.usdAmountCents, 0);
});

await check("A2b the website currency defaults to USD, accepts only USD/INR, and is stored", () => {
  assert.equal(site.siteCurrencySetting().saved, false);
  assert.equal(site.siteCurrency(), "USD", "USD when nothing has been saved");
  assert.throws(() => site.setSiteCurrency("EUR", "test"));
  site.setSiteCurrency("INR", "test");
  assert.equal(site.siteCurrency(), "INR");
  const prices = catalogue.listActivePlans().map((p) => [p.id, p.amountPaise, p.usdAmountCents]);
  site.setSiteCurrency("USD", "test");
  assert.deepEqual(catalogue.listActivePlans().map((p) => [p.id, p.amountPaise, p.usdAmountCents]), prices, "switching changes no plan price");
  assert.equal(site.sitePriceLabel(catalogue.requirePlan("pro"), "USD"), null, "no USD price means no label, not a conversion");
  site.setSiteCurrency("INR", "test");
});

await check("A3 INR and USD are edited independently", () => {
  let r = catalogue.updatePlan("basic", { usdAmountCents: 599 }, actor);
  assert.ok(r.ok);
  assert.equal(r.after.amountPaise, 39900, "INR not moved by a USD edit");
  assert.equal(r.after.usdAmountCents, 599);
  r = catalogue.updatePlan("basic", { amountPaise: 39900 }, actor);
  assert.equal(r.after.usdAmountCents, 599, "USD not moved by an INR edit");
  assert.equal(catalogue.updatePlan("basic", { usdAmountCents: -1 }, actor).ok, false);
  assert.equal(catalogue.updatePlan("basic", { usdAmountCents: 5.5 }, actor).ok, false);
  assert.equal(catalogue.updatePlan("basic", { usdAmountCents: 0 }, actor).ok, false, "a paid plan can't be $0");
  assert.equal(catalogue.updatePlan("free", { usdAmountCents: 100 }, actor).ok, false);
  const features = catalogue.requirePlan("basic").features;
  assert.deepEqual(catalogue.requirePlan("basic").features, features, "features unchanged");
});

// Gateways: real credential storage, every one enabled.
const cfg = L("payments/config.js");
cfg.saveGatewayCredentials({ id: "razorpay", values: { keyId: "rzp_test_abc", keySecret: "rzp_secret_xyz", webhookSecret: "rzp_wh" }, enabled: true, actorEmail: admin.email });
cfg.saveGatewayCredentials({ id: "cashfree", values: { appId: "cf_app", secretKey: "cf_secret" }, enabled: true, actorEmail: admin.email });
cfg.saveGatewayCredentials({ id: "paypal", values: { clientId: "pp_client", clientSecret: "pp_secret", webhookId: "pp_wh" }, enabled: true, actorEmail: admin.email });

await check("A4 currency capability comes from configuration: INR → Razorpay, Cashfree; USD → PayPal", () => {
  assert.deepEqual(payments.checkoutOptionsFor("INR").map((o) => o.id), ["razorpay", "cashfree"]);
  assert.deepEqual(payments.checkoutOptionsFor("USD").map((o) => o.id), ["paypal"]);
  const views = Object.fromEntries(cfg.gatewayViews().map((v) => [v.id, v]));
  assert.equal(views.razorpay.currencies.USD.available, false);
  assert.match(views.razorpay.currencies.USD.reason, /international payments/);
  assert.equal(views.paypal.currencies.INR.available, false);
  assert.equal(views.paypal.currencies.USD.basis, "settlement");
  assert.ok(!JSON.stringify(cfg.gatewayViews()).includes("rzp_secret_xyz"), "no secret in the view");
});

let inrOrder, usdOrder;
await check("A5 INR order: Razorpay is sent 39900 paise in INR, from the plan record", async () => {
  inrOrder = await open("basic", "INR", "razorpay");
  assert.ok(inrOrder.ok, inrOrder.message);
  assert.deepEqual([inrOrder.amountPaise, inrOrder.currency], [39900, "INR"]);
  const sent = lastBodyTo("razorpay");
  assert.deepEqual([sent.amount, sent.currency], [39900, "INR"]);
  const row = billing.findPaymentByOrderId(inrOrder.orderId);
  assert.deepEqual([row.amountPaise, row.currency, row.planId, row.gateway], [39900, "INR", "basic", "razorpay"]);
});

await check("A6 USD order: PayPal is sent \"5.99\" USD — the USD price, not a conversion", async () => {
  usdOrder = await open("basic", "USD", "paypal");
  assert.ok(usdOrder.ok, usdOrder.message);
  const unit = lastBodyTo("paypal").purchase_units[0];
  assert.deepEqual(unit.amount, { currency_code: "USD", value: "5.99" });
  assert.equal(unit.custom_id.split(":").length, 3);
  const row = billing.findPaymentByOrderId(usdOrder.orderId);
  assert.deepEqual([row.amountPaise, row.currency], [599, "USD"]);
});

await check("A7 Cashfree is sent rupees as an exact decimal string", async () => {
  const r = await open("pro", "INR", "cashfree");
  assert.ok(r.ok, r.message);
  const sent = lastBodyTo("cashfree.com");
  assert.deepEqual([sent.order_amount, sent.order_currency], ["999.00", "INR"]);
});

await check("A8 unsupported currency/gateway pairs are refused before any provider call", async () => {
  const before = calls.length;
  const usdRzp = await open("basic", "USD", "razorpay");
  assert.equal(usdRzp.code, "CURRENCY_UNSUPPORTED");
  assert.match(usdRzp.message, /PayPal/, "offers the gateway that can");
  const inrPp = await open("basic", "INR", "paypal");
  assert.equal(inrPp.code, "CURRENCY_UNSUPPORTED");
  const noUsd = await open("pro", "USD", "paypal");
  assert.equal(noUsd.code, "PRICE_NOT_CONFIGURED", "Pro has no USD price");
  const eur = await open("basic", "EUR", "paypal");
  assert.equal(eur.code, "CURRENCY_UNSUPPORTED");
  assert.equal(calls.length, before, "no request reached a provider");
});

await check("A9 USD through Razorpay only once declared on the account; then it is sent cents", async () => {
  cfg.saveGatewayCredentials({ id: "razorpay", values: { currencies: "USD" }, actorEmail: admin.email });
  assert.deepEqual(payments.checkoutOptionsFor("USD").map((o) => o.id), ["razorpay", "paypal"]);
  const r = await open("basic", "USD", "razorpay");
  assert.ok(r.ok, r.message);
  assert.deepEqual([lastBodyTo("razorpay").amount, lastBodyTo("razorpay").currency], [599, "USD"]);
  cfg.saveGatewayCredentials({ id: "razorpay", values: {}, clear: ["currencies"], actorEmail: admin.email });
  assert.deepEqual(payments.checkoutOptionsFor("USD").map((o) => o.id), ["paypal"]);
});

await check("A10 a disabled gateway cannot be used", async () => {
  cfg.setGatewayEnabled("cashfree", false, admin.email);
  const r = await open("basic", "INR", "cashfree");
  assert.equal(r.code, "GATEWAY_DISABLED");
  cfg.setGatewayEnabled("cashfree", true, admin.email);
});

const rzpSign = (orderId, paymentId) => createHmac("sha256", "rzp_secret_xyz").update(`${orderId}|${paymentId}`).digest("hex");
const subscriptionsOf = () => billing.listSubscriptions ? billing.listSubscriptions(buyer.id) : null;
const activeSub = () => billing.getActiveSubscription(buyer.id);

await check("A11 failed or unverifiable payments never grant a plan", async () => {
  // Forged signature.
  let r = await payments.verifyCheckout({ userId: buyer.id, orderId: inrOrder.orderId,
    payload: { razorpay_order_id: inrOrder.orderId, razorpay_payment_id: "pay_1", razorpay_signature: "deadbeef" } });
  assert.equal(r.ok, false);
  assert.equal(billing.findPaymentByOrderId(inrOrder.orderId).status, "failed", "a forged return closes the order");
  // Genuine signature, but Razorpay says a different amount was paid.
  const second = await open("basic", "INR", "razorpay");
  scenario.razorpayPayment = { id: "pay_2", order_id: second.orderId, status: "captured", amount: 100, currency: "INR", method: "upi" };
  r = await payments.verifyCheckout({ userId: buyer.id, orderId: second.orderId,
    payload: { razorpay_order_id: second.orderId, razorpay_payment_id: "pay_2", razorpay_signature: rzpSign(second.orderId, "pay_2") } });
  assert.equal(r.ok, false);
  assert.match(r.message, /amount/);
  // PayPal captured in the wrong currency.
  scenario.paypalCapture = { id: usdOrder.orderId, status: "COMPLETED", purchase_units: [{ amount: { currency_code: "EUR", value: "5.99" },
    payments: { captures: [{ id: "CAP1", status: "COMPLETED", custom_id: `${buyer.id}:basic:USD`, amount: { currency_code: "EUR", value: "5.99" } }] } }] };
  r = await payments.verifyCheckout({ userId: buyer.id, orderId: usdOrder.orderId, payload: { token: usdOrder.orderId } });
  assert.equal(r.ok, false);
  assert.match(r.message, /currency/);
  // Voided at PayPal.
  const third = await open("basic", "USD", "paypal");
  scenario.paypalCapture = { status: "VOIDED" };
  r = await payments.verifyCheckout({ userId: buyer.id, orderId: third.orderId, payload: { token: third.orderId } });
  assert.equal(r.ok, false);
  assert.equal(activeSub()?.planId ?? "free", "free", "still on Free");
});

let usdSub;
await check("A12 a verified USD payment grants Basic, recorded in USD across payment, subscription and invoice", async () => {
  usdOrder = await open("basic", "USD", "paypal");
  scenario.paypalCapture = { id: usdOrder.orderId, status: "COMPLETED", purchase_units: [{ amount: { currency_code: "USD", value: "5.99" },
    payments: { captures: [{ id: "CAP2", status: "COMPLETED", custom_id: `${buyer.id}:basic:USD`, amount: { currency_code: "USD", value: "5.99" } }] } }] };
  const r = await payments.verifyCheckout({ userId: buyer.id, orderId: usdOrder.orderId, payload: { token: usdOrder.orderId } });
  assert.ok(r.ok, r.message);
  usdSub = billing.findSubscription(r.subscriptionId);
  assert.deepEqual([usdSub.planId, usdSub.amountPaise, usdSub.currency], ["basic", 599, "USD"]);
  const pay = billing.findPaymentByOrderId(usdOrder.orderId);
  assert.deepEqual([pay.status, pay.amountPaise, pay.currency], ["paid", 599, "USD"]);
  const invoice = billing.findInvoiceByPayment(pay.id);
  assert.deepEqual([invoice.amountPaise, invoice.currency], [599, "USD"]);
  // A second capture report for the same order changes nothing.
  const again = await payments.verifyCheckout({ userId: buyer.id, orderId: usdOrder.orderId, payload: { token: usdOrder.orderId } });
  assert.equal(again.ok && again.status, "already");
});

let inrSub;
await check("A13 a verified INR payment is recorded in INR", async () => {
  const order = await open("pro", "INR", "razorpay");
  scenario.razorpayPayment = { id: "pay_9", order_id: order.orderId, status: "captured", amount: 99900, currency: "INR", method: "upi" };
  const r = await payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId,
    payload: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_9", razorpay_signature: rzpSign(order.orderId, "pay_9") } });
  assert.ok(r.ok, r.message);
  inrSub = billing.findSubscription(r.subscriptionId);
  assert.deepEqual([inrSub.amountPaise, inrSub.currency], [99900, "INR"]);
});

await check("A14 an order opened before USD prices (converted, two-part custom_id) still settles as before", async () => {
  // Exactly the row the old PayPal path wrote: priced in INR paise, charged in USD.
  const legacyId = `PPLEGACY${stamp}`;
  billing.createPayment({ userId: buyer.id, planId: "basic", amountPaise: 39900, currency: "INR", orderId: legacyId,
    gateway: "paypal", environment: "sandbox", mode: "live", receipt: `rcpt_legacy_${stamp}` });
  scenario.paypalCapture = { id: legacyId, status: "COMPLETED", purchase_units: [{ amount: { currency_code: "USD", value: "4.52" },
    payments: { captures: [{ id: "CAPL", status: "COMPLETED", custom_id: `${buyer.id}:basic`, amount: { currency_code: "USD", value: "4.52" } }] } }] };
  const r = await payments.verifyCheckout({ userId: buyer.id, orderId: legacyId, payload: { token: legacyId } });
  assert.ok(r.ok, r.message);
  const pay = billing.findPaymentByOrderId(legacyId);
  assert.deepEqual([pay.amountPaise, pay.currency], [39900, "INR"], "the row keeps what it recorded");
});

await check("A15 re-pricing later rewrites no history and reprices no live subscription", () => {
  catalogue.updatePlan("basic", { amountPaise: 44900, usdAmountCents: 649 }, actor);
  const pay = billing.findPaymentByOrderId(usdOrder.orderId);
  assert.deepEqual([pay.amountPaise, pay.currency], [599, "USD"]);
  assert.deepEqual([billing.findSubscription(usdSub.id).amountPaise, billing.findSubscription(usdSub.id).currency], [599, "USD"]);
  assert.deepEqual([billing.findSubscription(inrSub.id).amountPaise, billing.findSubscription(inrSub.id).currency], [99900, "INR"]);
  assert.equal(billing.findInvoiceByPayment(pay.id).amountPaise, 599);
});

await check("A16 admin revenue is reported per currency, never summed across them", () => {
  const stats = L("db/admin.js").adminStats();
  assert.equal(stats.revenueByCurrency.USD, 599);
  assert.equal(stats.revenueByCurrency.INR, 99900 + 39900);
  assert.equal(stats.revenuePaise, stats.revenueByCurrency.INR);
});

// Leaves Pro without a USD price and Basic at ₹449 / $6.49. The server
// below opens the same SQLite file (WAL); this process keeps reading it.
globalThis.fetch = realFetch;

/* ════════════════════ Part B — HTTP ════════════════════ */

const port = 4500 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: projectRoot,
  env: isolatedServerEnv({ ...process.env, ...SECRETS, NODE_ENV: "production", DATA_DIR: dataDir }),
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const flat = (html) => html.replace(/<!-- -->/g, "");
async function call(pathname, { method = "GET", body, cookie } = {}) {
  const headers = new Headers({ "x-forwarded-for": `198.51.100.${(seq % 250) + 1}` });
  seq += 1;
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET") headers.set("origin", base);
  if (body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text: flat(text), json: data, res };
}

async function login(email) {
  const r = await call("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(r.status, 200, `login ${email}: ${r.text}`);
  return r.res.headers.getSetCookie().find((c) => c.startsWith("aec_session=")).split(";", 1)[0];
}

try {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const adminCookie = await login(admin.email);
  const buyerCookie = await login(buyer.email);
  const browserCookie = await login(browser.email);

  await check("B1 admin sets the INR price through the API, with an explicit confirmation", async () => {
    const ask = await call("/api/admin/pricing/basic", { method: "PATCH", cookie: adminCookie, body: { inr: "399" } });
    assert.equal(ask.status, 409);
    assert.equal(ask.json.code, "CONFIRMATION_REQUIRED");
    assert.match(ask.json.summary, /INR ₹449 → ₹399/);
    assert.equal(catalogue.requirePlan("basic").amountPaise, 44900, "nothing written before confirming");
    const ok = await call("/api/admin/pricing/basic", { method: "PATCH", cookie: adminCookie, body: { inr: "399", confirmed: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(catalogue.requirePlan("basic").amountPaise, 39900);
    assert.equal(catalogue.requirePlan("basic").usdAmountCents, 649, "USD untouched");
  });

  await check("B2 admin sets the USD price independently; INR is untouched", async () => {
    const ok = await call("/api/admin/pricing/basic", { method: "PATCH", cookie: adminCookie, body: { usd: "5.99", confirmed: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([catalogue.requirePlan("basic").amountPaise, catalogue.requirePlan("basic").usdAmountCents], [39900, 599]);
    for (const bad of ["-1", "5.999", "abc", "1e2"]) {
      const r = await call("/api/admin/pricing/basic", { method: "PATCH", cookie: adminCookie, body: { usd: bad, confirmed: true } });
      assert.equal(r.status, 400, `rejects ${bad}`);
      assert.ok(r.json.fields.usd);
    }
    const free = await call("/api/admin/pricing/free", { method: "PATCH", cookie: adminCookie, body: { usd: "1", confirmed: true } });
    assert.equal(free.status, 400);
    const log = await call("/admin/logs", { cookie: adminCookie });
    assert.match(log.text, /USD price \$6\.49 → \$5\.99/);
  });

  await check("B3 customers and anonymous visitors cannot change prices", async () => {
    const cust = await call("/api/admin/pricing/basic", { method: "PATCH", cookie: buyerCookie, body: { inr: "1", confirmed: true } });
    assert.equal(cust.status, 403);
    const anon = await call("/api/admin/pricing/basic", { method: "PATCH", body: { inr: "1", confirmed: true } });
    assert.equal(anon.status, 401);
    assert.equal((await call("/admin/pricing", { cookie: buyerCookie })).status, 404);
    assert.equal(catalogue.requirePlan("basic").amountPaise, 39900);
  });

  await check("B4 the admin Pricing page lists every plan with INR and USD columns", async () => {
    const page = await call("/admin/pricing", { cookie: adminCookie });
    assert.equal(page.status, 200);
    for (const text of ["Free", "Basic", "Pro", "INR price", "USD price", "₹399", "$5.99", "₹999", "Not offered", "Monthly"]) {
      assert.ok(page.text.includes(text), `shows ${text}`);
    }
    assert.match(page.text, /Paid through PayPal/);
  });

  await check("B5 the pricing page shows only the website currency, with no switcher", async () => {
    site.setSiteCurrency("INR", admin.email);
    const inr = await call("/pricing");
    assert.match(inr.text, /₹399/);
    assert.match(inr.text, /₹999/);
    assert.doesNotMatch(inr.text, /\$5\.99/);
    assert.doesNotMatch(inr.text, /aria-label="Currency"/, "no currency switcher");
    assert.match(inr.text, /Prices in Indian rupees per month/);
    site.setSiteCurrency("USD", admin.email);
    const usd = await call("/pricing");
    assert.match(usd.text, /\$5\.99/);
    assert.match(usd.text, /\$0/);
    assert.match(usd.text, /Not available to buy right now/, "Pro has no USD price and says so");
    assert.doesNotMatch(usd.text, /₹/, "no rupee price anywhere");
    assert.doesNotMatch(usd.text, /aria-label="Currency"/);
    assert.match(usd.text, /Prices in US dollars per month/);
    const override = await call("/pricing?currency=INR");
    assert.doesNotMatch(override.text, /₹399/, "a customer can't switch currency with the URL");
    const home = await call("/");
    assert.match(home.text, /\$5\.99/);
    assert.doesNotMatch(home.text, /aria-label="Currency"/);
    assert.doesNotMatch(home.text, /₹399/);
  });

  await check("B6 plan buttons carry only the plan; checkout charges the website currency and can't be switched", async () => {
    const usd = await call("/pricing", { cookie: browserCookie });
    assert.match(usd.text, /href="\/checkout\?plan=basic"/);
    const anon = await call("/pricing");
    assert.match(anon.text, /next=%2Fcheckout%3Fplan%3Dbasic&amp;plan=basic/);
    const checkout = await call("/checkout?plan=basic", { cookie: browserCookie });
    assert.equal(checkout.status, 200);
    assert.match(checkout.text, /\$5\.99/);
    assert.match(checkout.text, /USD · US dollars/);
    assert.match(checkout.text, /PayPal/);
    assert.doesNotMatch(checkout.text, /value="razorpay"/, "no gateway that can't take USD");
    assert.doesNotMatch(checkout.text, /₹/, "no rupees on a USD checkout");
    const tampered = await call("/checkout?plan=basic&currency=INR", { cookie: browserCookie });
    assert.match(tampered.text, /\$5\.99/, "the currency in the link is ignored");
    site.setSiteCurrency("INR", admin.email);
    const inr = await call("/checkout?plan=basic&currency=USD", { cookie: browserCookie });
    assert.match(inr.text, /₹399/);
    assert.doesNotMatch(inr.text, /\$5\.99/);
    assert.doesNotMatch(inr.text, /instead/, "no offer to pay in another currency");
  });

  await check("B7 a plan with no price in the website currency can't be bought", async () => {
    site.setSiteCurrency("USD", admin.email);
    const pro = await call("/checkout?plan=pro", { cookie: buyerCookie });
    assert.match(pro.text, /Pro can&#x27;t be bought right now/);
    const adminPricing = await call("/admin/pricing", { cookie: adminCookie });
    assert.match(adminPricing.text, /Pro has no USD price/, "the admin is warned");
  });

  const order = (body) => call("/api/checkout/order", { method: "POST", cookie: buyerCookie,
    body: { billing: { name: "Asha Buyer", email: "asha@example.test", country: "IN", phone: "98765 43210" }, attemptId: randomUUID(), ...body } });

  await check("B8 the order route uses the website currency; stale pages, tampered values and unsupported gateways are refused", async () => {
    // Site is USD.
    let r = await order({ planId: "basic", currency: "INR", gateway: "paypal" });
    assert.equal(r.json.code, "PRICE_CHANGED", "a page opened in INR before the switch");
    assert.equal(r.status, 409);
    r = await order({ planId: "basic", currency: "USD", expectedAmount: 39900, gateway: "paypal" });
    assert.equal(r.json.code, "PRICE_CHANGED", "the amount the customer saw is no longer the price");
    assert.equal((await order({ planId: "basic", gateway: "razorpay" })).json.code, "CURRENCY_UNSUPPORTED", "Razorpay isn't set up for USD");
    assert.equal((await order({ planId: "basic", currency: "GBP", gateway: "paypal" })).json.code, "CURRENCY_UNSUPPORTED");
    assert.equal((await order({ planId: "pro", currency: "USD", gateway: "paypal" })).json.code, "PRICE_NOT_CONFIGURED");
    const crafted = await order({ planId: "pro", gateway: "paypal", amount: 1, amountPaise: 1, price: "0.01", total: 1 });
    assert.equal(crafted.json.code, "PRICE_NOT_CONFIGURED", "sent amounts are never read");
    site.setSiteCurrency("INR", admin.email);
    assert.equal((await order({ planId: "basic", currency: "INR", gateway: "paypal" })).json.code, "CURRENCY_UNSUPPORTED", "PayPal doesn't take INR");
    assert.equal((await order({ planId: "basic", currency: "USD", gateway: "razorpay" })).json.code, "PRICE_CHANGED");
  });

  await check("B8b only administrators change the website currency; it is validated, confirmed, logged and kept", async () => {
    const put = (cookie, body) => call("/api/admin/settings/currency", { method: "PUT", cookie, body });
    assert.equal((await put(buyerCookie, { currency: "USD", confirmed: true })).status, 403);
    assert.equal((await call("/api/admin/settings/currency", { method: "PUT", body: { currency: "USD", confirmed: true } })).status, 401);
    assert.equal((await put(adminCookie, { currency: "EUR", confirmed: true })).status, 400);
    assert.equal((await put(adminCookie, { currency: "usd; drop", confirmed: true })).status, 400);
    const ask = await put(adminCookie, { currency: "USD" });
    assert.equal(ask.status, 409);
    assert.equal(ask.json.code, "CONFIRMATION_REQUIRED");
    assert.equal(ask.json.ready, false);
    assert.match(ask.json.missingPrices, /Pro/);
    assert.equal(site.siteCurrency(), "INR", "nothing changes before confirming");
    const ok = await put(adminCookie, { currency: "USD", confirmed: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.setting.currency, "USD");
    assert.equal(site.siteCurrency(), "USD", "saved in the database, seen by another process");
    const page = await call("/admin/settings/currency", { cookie: adminCookie });
    assert.match(page.text, /Active currency: USD/);
    assert.match(page.text, /No USD price for Pro/);
    assert.equal((await call("/admin/settings/currency", { cookie: buyerCookie })).status, 404);
    const logs = await call("/admin/logs", { cookie: adminCookie });
    assert.match(logs.text, /settings\.currency_changed/);
  });

  await check("B9 a disabled gateway is refused by the order route", async () => {
    site.setSiteCurrency("INR", admin.email);
    cfg.setGatewayEnabled("cashfree", false, admin.email);
    const r = await order({ planId: "basic", currency: "INR", gateway: "cashfree" });
    assert.equal(r.json.code, "GATEWAY_DISABLED");
    cfg.setGatewayEnabled("cashfree", true, admin.email);
  });

  await check("B10 billing and admin tables show each amount in its own currency", async () => {
    // The site is switched to USD: payments already made keep their currency.
    site.setSiteCurrency("USD", admin.email);
    const bill = await call("/dashboard/billing", { cookie: buyerCookie });
    assert.equal(bill.status, 200);
    assert.match(bill.text, /\$5\.99/, "USD payment shown in dollars");
    assert.match(bill.text, /₹999/, "INR payment shown in rupees");
    assert.match(bill.text, /₹1,398 \+ \$5\.99|\$5\.99 \+ ₹1,398/, "paid-so-far kept per currency");
    const subs = await call("/admin/subscriptions", { cookie: adminCookie });
    assert.match(subs.text, /\$5\.99/);
    assert.match(subs.text, /₹999/);
    assert.match(subs.text, /\+ \$5\.99/, "USD revenue shown separately");
    const pay = billing.findPaymentByOrderId(usdOrder.orderId);
    const invoice = billing.findInvoiceByPayment(pay.id);
    const inv = await call(`/dashboard/billing/invoices/${invoice.id}`, { cookie: buyerCookie });
    assert.match(inv.text, /\$5\.99/);
    assert.doesNotMatch(inv.text, /₹5\.99/);
  });

  await check("B11 the admin gateway page shows INR/USD availability with reasons, no secrets", async () => {
    const page = await call("/admin/payment-gateways", { cookie: adminCookie });
    assert.match(page.text, /Checkout currencies/);
    assert.match(page.text, /only takes USD once international payments are enabled/);
    assert.match(page.text, /doesn&#x27;t include INR/);
    assert.ok(!page.text.includes("rzp_secret_xyz") && !page.text.includes("pp_secret") && !page.text.includes("cf_secret"));
  });

  assert.ok(!serverLog.includes("rzp_secret_xyz") && !serverLog.includes("pp_secret"), "no secret in server logs");
  console.log(`pricing & currency regression: passed (${passed} checks)`);
} finally {
  server.kill();
  rmSync(workDir, { recursive: true, force: true });
}
