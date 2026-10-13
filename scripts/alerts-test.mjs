// Payment-failure and abandoned-checkout alerts.
//
//     npm run build && node scripts/alerts-test.mjs
//
// Part A runs the real lib/ modules (compiled to CommonJS, as verify.mjs
// does) with a controllable clock: the job takes `now`, so a 30-minute
// grace period is tested by passing a later time, not by waiting. The
// Razorpay and Resend APIs are answered by stand-ins so delivery can be
// made to succeed, fail temporarily or be rejected on demand.
//
// Part B starts the production build and checks the admin settings API,
// the checkout-progress endpoint, the scheduler endpoint's protection, and
// an end-to-end abandonment with no browser involved.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { registerVerified, startMailSink } from "./lib/mail-sink.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(path.join(tmpdir(), "aec-alerts-"));
const outDir = path.join(workDir, "build");
const dataDir = path.join(workDir, "data");
mkdirSync(dataDir, { recursive: true });

const SECRETS = {
  AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345",
  CREDENTIALS_SECRET: randomBytes(48).toString("base64"),
};
Object.assign(process.env, SECRETS, {
  DATA_DIR: dataDir,
  NODE_ENV: "development",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "AdSense Checker <alerts@example.test>",
  RESEND_API_URL: "https://resend.stub/emails",
  NEXT_PUBLIC_APP_URL: "https://checker.example.test",
});
for (const name of ["PAYMENTS_MODE", "ADMIN_EMAIL", "ADMIN_PASSWORD", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) {
  delete process.env[name];
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    if (error?.message?.length > 400) { error.message = `${error.message.slice(0, 300)}…`; delete error.actual; }
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
      target: "es2022", module: "commonjs", moduleResolution: "node", esModuleInterop: true, skipLibCheck: true,
      strict: true, outDir, rootDir: projectRoot, baseUrl: projectRoot, paths: { "@/*": ["./*"] }, types: ["node"],
      typeRoots: [path.join(projectRoot, "node_modules", "@types")],
    },
    include: [path.join(projectRoot, "lib/**/*.ts")],
  }));
  execFileSync(path.join(projectRoot, "node_modules", ".bin", "tsc"), ["-p", tsconfig], { stdio: "inherit" });
  const nodeModules = path.join(outDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(outDir, path.join(nodeModules, "@"), "dir");
  for (const pkg of ["libphonenumber-js", "sharp"]) {
    try { symlinkSync(path.join(projectRoot, "node_modules", pkg), path.join(nodeModules, pkg), "dir"); } catch { /* optional */ }
  }
}

/* ── stand-ins for Razorpay and Resend ─────────────────────────── */

const realFetch = globalThis.fetch;
const emails = [];
const scenario = { razorpayPayment: null, resend: "ok" }; // ok | outage | reject
let seq = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(init.body) : null;
  if (url === "https://resend.stub/emails") {
    if (scenario.resend === "outage") return json(503, { message: "unavailable" });
    if (scenario.resend === "reject") return json(422, { message: "invalid from" });
    emails.push(body);
    return json(200, { id: `em_${emails.length}` });
  }
  if (url === "https://api.razorpay.com/v1/orders") return json(200, { id: `order_rzp_${++seq}` });
  if (url.startsWith("https://api.razorpay.com/v1/payments/")) return json(200, scenario.razorpayPayment);
  return json(404, { message: `no stub for ${url}` });
};

compileLib();
const req = createRequire(path.join(outDir, "lib", "x.js"));
const L = (m) => req(path.join(outDir, "lib", m));
const accounts = L("db/accounts.js");
const billing = L("db/billing.js");
const { hashPasswordSync } = L("auth/password.js");
const catalogue = L("plan-catalogue.js");
const payments = L("payments/index.js");
const cfg = L("payments/config.js");
const settings = L("alerts/settings.js");
const checkout = L("alerts/checkout.js");
const notify = L("alerts/notify.js");
const job = L("alerts/job.js");

const dbq = (sql, ...args) => L("db/index.js").many(sql, args);

console.log("payment & checkout alerts");

const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = accounts.createUser({ name: "Admin", email: `al-admin-${stamp}@example.test`, passwordHash: hashPasswordSync(password), role: "admin" });
const buyer = accounts.createUser({ name: "Kiran Rao", email: `al-buyer-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
cfg.saveGatewayCredentials({ id: "razorpay", values: { keyId: "rzp_test_abc", keySecret: "rzp_secret_xyz", webhookSecret: "rzp_wh_secret" }, enabled: true, actorEmail: admin.email });
const billingDetails = { name: "Kiran Rao", email: "kiran@example.test", phone: "+919876543210", country: "IN" };

const open = (planId = "basic") =>
  payments.startCheckout({
    userId: buyer.id, plan: catalogue.requirePlan(planId), currency: "INR", gateway: "razorpay",
    customerName: "Kiran", customerEmail: billingDetails.email, billing: billingDetails,
    returnUrl: "http://127.0.0.1/r", idempotencyKey: randomUUID(),
  });
const sign = (orderId, paymentId) => createHmac("sha256", "rzp_secret_xyz").update(`${orderId}|${paymentId}`).digest("hex");
const returnWith = (order, paymentId, status) => {
  scenario.razorpayPayment = { id: paymentId, order_id: order.orderId, status, amount: 39900, currency: "INR", method: "card" };
  return payments.verifyCheckout({
    userId: buyer.id, orderId: order.orderId,
    payload: { razorpay_order_id: order.orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(order.orderId, paymentId) },
  });
};
const alertsFor = (type) => dbq("SELECT * FROM notifications WHERE type = ? ORDER BY created_at", type);
const settle = () => new Promise((r) => setTimeout(r, 50)); // let the immediate send finish

/* ════════════════════ Part A ════════════════════ */

await check("A1 the alert email is validated and stored; invalid addresses are refused", () => {
  for (const bad of ["", "not-an-email", "a@b", "a b@c.com", "x@y.c", "<a@b.com>"]) assert.equal(settings.normalizeAlertEmail(bad), null, bad);
  assert.equal(settings.normalizeAlertEmail("  Owner@Example.TEST "), "owner@example.test");
  assert.equal(settings.alertEmail(), null, "nothing configured by default");
  settings.setAlertEmail("owner@example.test", admin.email);
  assert.equal(settings.alertEmail(), "owner@example.test");
  assert.equal(settings.graceMinutes(), 30, "default grace period");
});

await check("A2 a provider-confirmed failed payment sends one Payment Failed alert with the details", async () => {
  const order = await open("basic");
  const r = await returnWith(order, "pay_fail_1", "failed");
  assert.equal(r.ok, false);
  await settle();
  const [row] = alertsFor("payment_failed");
  assert.equal(row.status, "sent");
  assert.equal(row.order_id, order.orderId);
  const mail = emails.at(-1);
  assert.equal(mail.to[0], "owner@example.test");
  assert.equal(mail.subject, `[AdSense Checker] Payment Failed — Basic Plan — Order #${order.orderId}`);
  for (const text of ["Kiran Rao", "kiran@example.test", "+919876543210", buyer.id, "Basic (basic)", "INR", "₹399.00", "Razorpay", order.orderId, "Failed (confirmed by the provider)", "Amount charged", `https://checker.example.test/admin/users/${buyer.id}`]) {
    assert.ok(mail.text.includes(text), `email shows ${text}`);
  }
  assert.match(mail.html, /width=device-width/);
  for (const secret of ["rzp_secret_xyz", "rzp_wh_secret", "re_test_key", password]) {
    assert.ok(!mail.text.includes(secret) && !mail.html.includes(secret), "no secrets in the alert");
  }
});

await check("A3 pending payments, cancellations and our own signature refusals send no failure alert", async () => {
  const before = alertsFor("payment_failed").length;
  const pending = await open("basic");
  const p = await returnWith(pending, "pay_p", "created"); // not captured yet
  assert.equal(p.ok, false);
  assert.equal(billing.findPaymentByOrderId(pending.orderId).status, "created", "pending stays open");
  const forged = await open("basic");
  await payments.verifyCheckout({ userId: buyer.id, orderId: forged.orderId,
    payload: { razorpay_order_id: forged.orderId, razorpay_payment_id: "pay_x", razorpay_signature: "bad" } });
  const closed = await open("basic");
  billing.markPaymentFailed(closed.orderId, "Cancelled at checkout", "cancelled");
  await settle();
  assert.equal(alertsFor("payment_failed").length, before, "no new alert");
});

await check("A4 a browser timeout is not a failure: an order nobody confirmed stays open and silent", async () => {
  const before = alertsFor("payment_failed").length;
  const order = await open("basic");
  // The browser never comes back. Time passes; the job runs.
  await job.runAlertJob(Date.now() + 3 * 60 * 60_000);
  assert.equal(billing.findPaymentByOrderId(order.orderId).status, "created");
  assert.equal(alertsFor("payment_failed").length, before);
});

await check("A5 the same failure reported by the return and by a signed webhook alerts once", async () => {
  const order = await open("basic");
  await returnWith(order, "pay_dup", "failed");
  const raw = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_dup", order_id: order.orderId, error_description: "Card declined" } } } });
  const sig = createHmac("sha256", "rzp_wh_secret").update(raw).digest("hex");
  for (let i = 0; i < 2; i += 1) {
    await payments.processWebhook("razorpay", raw, new Headers({ "x-razorpay-signature": sig, "x-razorpay-event-id": `evt_${i}` }));
  }
  await settle();
  assert.equal(dbq("SELECT COUNT(*) n FROM notifications WHERE order_id = ?", order.orderId)[0].n, 1);
});

await check("A6 a signed payment.failed webhook on its own raises the alert", async () => {
  const order = await open("pro");
  const raw = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_w", order_id: order.orderId, error_description: "Insufficient funds" } } } });
  const sig = createHmac("sha256", "rzp_wh_secret").update(raw).digest("hex");
  const res = await payments.processWebhook("razorpay", raw, new Headers({ "x-razorpay-signature": sig }));
  assert.equal(res.httpStatus, 200);
  await settle();
  assert.ok(emails.at(-1).text.includes("Insufficient funds"));
  assert.ok(emails.at(-1).subject.includes("Pro Plan"));
  // An unsigned copy does nothing.
  const order2 = await open("pro");
  const raw2 = raw.replace(order.orderId, order2.orderId);
  await payments.processWebhook("razorpay", raw2, new Headers({ "x-razorpay-signature": "forged" }));
  await settle();
  assert.equal(dbq("SELECT COUNT(*) n FROM notifications WHERE order_id = ?", order2.orderId)[0].n, 0);
});

const t0 = Date.now();
const save = (planId = "basic", checkoutId, now = t0) =>
  checkout.saveCheckoutProgress({
    checkoutId, userId: buyer.id, plan: { id: planId, name: catalogue.requirePlan(planId).name }, currency: "INR",
    amountMinor: catalogue.requirePlan(planId).amountPaise, billing: billingDetails, now,
  });

let abandonedId;
await check("A7 saved details with no Pay attempt are flagged only after the grace period, once", async () => {
  // Clear out earlier open orders so the convert check sees a clean slate.
  dbq("DELETE FROM payments WHERE user_id = ?", buyer.id);
  const session = save("basic", undefined, t0);
  abandonedId = session.id;
  assert.match(session.id, /^chk_[A-Za-z0-9_-]{16}$/);
  let r = await job.runAlertJob(t0 + 29 * 60_000);
  assert.equal(r.abandoned, 0, "not yet");
  assert.equal(checkout.findCheckoutSession(session.id).status, "in_progress");
  r = await job.runAlertJob(t0 + 31 * 60_000);
  assert.equal(r.abandoned, 1);
  const [row] = alertsFor("abandoned_checkout");
  assert.equal(row.status, "sent");
  const mail = emails.at(-1);
  assert.equal(mail.subject, "[AdSense Checker] Abandoned Checkout — Basic Plan");
  for (const text of ["Kiran Rao", "kiran@example.test", "₹399.00", session.id, "Pay was never pressed"]) assert.ok(mail.text.includes(text), text);
  r = await job.runAlertJob(t0 + 90 * 60_000);
  assert.equal(r.abandoned, 0, "never flagged twice");
  assert.equal(alertsFor("abandoned_checkout").length, 1);
});

await check("A8 pressing Pay takes a checkout out of the sweep, even while the payment is pending", async () => {
  const session = save("pro", undefined, t0);
  const order = await open("pro");
  checkout.markPaymentStarted({ checkoutId: session.id, userId: buyer.id, planId: "pro", orderId: order.orderId, now: t0 + 60_000 });
  const r = await job.runAlertJob(t0 + 3 * 60 * 60_000);
  assert.equal(r.abandoned, 0);
  assert.equal(checkout.findCheckoutSession(session.id).status, "payment_started");
});

await check("A9 a successful payment closes the checkout — no abandoned alert", async () => {
  const session = save("pro", undefined, t0);
  const order = await open("pro");
  checkout.markPaymentStarted({ checkoutId: session.id, userId: buyer.id, planId: "pro", orderId: order.orderId, now: t0 + 1000 });
  scenario.razorpayPayment = { id: "pay_ok", order_id: order.orderId, status: "captured", amount: 99900, currency: "INR", method: "upi" };
  const ok = await payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId,
    payload: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_ok", razorpay_signature: sign(order.orderId, "pay_ok") } });
  assert.ok(ok.ok, ok.message);
  assert.equal(checkout.findCheckoutSession(session.id).status, "paid");
  const before = alertsFor("abandoned_checkout").length;
  await job.runAlertJob(t0 + 5 * 60 * 60_000);
  assert.equal(alertsFor("abandoned_checkout").length, before);
});

await check("A10 an abandoned checkout that later fails payment gets one clear failure alert, not a second abandonment", async () => {
  const order = await open("basic");
  checkout.markPaymentStarted({ checkoutId: abandonedId, userId: buyer.id, planId: "basic", orderId: order.orderId });
  await returnWith(order, "pay_late", "failed");
  await settle();
  const mail = emails.at(-1);
  assert.ok(mail.subject.startsWith("[AdSense Checker] Payment Failed"));
  assert.match(mail.text, /flagged as abandoned/);
  assert.equal(alertsFor("abandoned_checkout").length, 1);
});

await check("A11 a temporary provider outage is retried with backoff; a rejection is not retried endlessly", async () => {
  scenario.resend = "outage";
  const s = save("basic", undefined, t0 + 1);
  dbq("DELETE FROM payments WHERE user_id = ?", buyer.id);
  await job.runAlertJob(t0 + 40 * 60_000);
  let [row] = dbq("SELECT * FROM notifications WHERE checkout_id = ?", s.id);
  assert.equal(row.status, "retry");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /Temporary: HTTP 503/);
  assert.ok(row.next_attempt_at > t0 + 40 * 60_000, "waits before retrying");
  await job.runAlertJob(t0 + 40 * 60_000 + 30_000);
  assert.equal(dbq("SELECT attempts FROM notifications WHERE id = ?", row.id)[0].attempts, 1, "not retried before its time");
  scenario.resend = "ok";
  await job.runAlertJob(t0 + 42 * 60_000);
  [row] = dbq("SELECT * FROM notifications WHERE id = ?", row.id);
  assert.deepEqual([row.status, row.attempts], ["sent", 2]);
  assert.ok(row.provider_id);

  scenario.resend = "reject";
  dbq("DELETE FROM payments WHERE user_id = ?", buyer.id);
  // Basic: this customer already holds Pro (A9), which would make a Pro checkout "converted".
  const s2 = save("basic", undefined, t0 + 2);
  await job.runAlertJob(t0 + 45 * 60_000);
  let [rej] = dbq("SELECT * FROM notifications WHERE checkout_id = ?", s2.id);
  assert.equal(rej.status, "failed", "a 422 is permanent");
  assert.match(rej.last_error, /Rejected: HTTP 422/);
  await job.runAlertJob(t0 + 10 * 60 * 60_000);
  assert.equal(dbq("SELECT attempts FROM notifications WHERE id = ?", rej.id)[0].attempts, 1, "never retried automatically");
  scenario.resend = "ok";
  assert.equal(notify.requeue(rej.id), true, "an admin can retry it");
  assert.equal(await notify.deliver(rej.id), "sent");
});

await check("A12 the same alert cannot be sent twice, even by two workers at once", async () => {
  scenario.resend = "ok";
  const s = save("basic", undefined, t0 + 3);
  dbq("DELETE FROM payments WHERE user_id = ?", buyer.id);
  checkout.claimAbandoned(t0 + 60 * 60_000, 30 * 60_000, 50).forEach((c) => notify.notifyAbandoned(c, t0 + 60 * 60_000));
  const [row] = dbq("SELECT * FROM notifications WHERE checkout_id = ?", s.id);
  const sentBefore = emails.length;
  const at = t0 + 60 * 60_000; // the test clock the alert was queued at
  const outcomes = await Promise.all([notify.deliver(row.id, at), notify.deliver(row.id, at), notify.deliver(row.id, at)]);
  assert.equal(outcomes.filter((o) => o === "sent").length, 1);
  assert.equal(emails.length, sentBefore + 1);
  assert.equal(notify.notifyAbandoned(checkout.findCheckoutSession(s.id)), null, "enqueueing the same event again is ignored");
});

await check("A13 with no alert email, nothing is sent and the history says why", async () => {
  settings.setAlertEmail(null, admin.email);
  const sent = emails.length;
  const s = save("basic", undefined, t0 + 4);
  dbq("DELETE FROM payments WHERE user_id = ?", buyer.id);
  await job.runAlertJob(t0 + 70 * 60_000);
  const [row] = dbq("SELECT * FROM notifications WHERE checkout_id = ?", s.id);
  assert.equal(row.status, "skipped");
  assert.match(row.last_error, /No alert email/);
  assert.equal(emails.length, sent);
  settings.setAlertEmail("owner@example.test", admin.email);
});

await check("A14 a checkout bought another way is not reported as abandoned", async () => {
  const s = save("basic", undefined, t0 + 5);
  billing.createPayment({ userId: buyer.id, planId: "basic", amountPaise: 39900, currency: "INR", orderId: `ord_other_${stamp}`,
    gateway: "razorpay", environment: "sandbox", mode: "live", receipt: `r_${stamp}` });
  await job.runAlertJob(t0 + 80 * 60_000);
  assert.equal(checkout.findCheckoutSession(s.id).status, "payment_started");
  assert.equal(dbq("SELECT COUNT(*) n FROM notifications WHERE checkout_id = ?", s.id)[0].n, 0);
});

globalThis.fetch = realFetch;

/* ════════════════════ Part B — HTTP ════════════════════ */

const mail = await startMailSink();
const CRON_SECRET = randomBytes(32).toString("hex");
const port = 5000 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: projectRoot,
  env: { ...process.env, ...SECRETS, ...mail.env, NODE_ENV: "production", DATA_DIR: dataDir, CRON_SECRET, CHECKOUT_ALERTS_BACKGROUND: "off", NEXT_PUBLIC_APP_URL: base },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let ipn = 0;
function browser() {
  const jar = new Map();
  const ip = `198.51.100.${(ipn += 1)}`;
  return async (pathname, { method = "GET", body, headers = {} } = {}) => {
    const h = new Headers({ "x-forwarded-for": ip, ...headers });
    if (jar.size) h.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (method !== "GET" && !headers.origin && !("authorization" in headers)) h.set("origin", base);
    if (body !== undefined) h.set("content-type", "application/json");
    const res = await fetch(`${base}${pathname}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [k, ...v] = pair.split("=");
      if (/Max-Age=0/i.test(raw)) jar.delete(k); else jar.set(k, v.join("="));
    }
    const text = (await res.text()).replace(/<!-- -->/g, "");
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };
}
const db = () => { const h = new DatabaseSync(path.join(dataDir, "app.db")); h.exec("PRAGMA busy_timeout = 5000"); return h; };
const q = (sql, ...a) => { const h = db(); try { return h.prepare(sql).all(...a); } finally { h.close(); } };

try {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Rupee checkout, as set in Admin → Website currency.
  q("INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES ('site.currency', 'INR', ?, 'test')", Date.now());
  const staff = browser();
  assert.equal((await staff("/api/auth/login", { method: "POST", body: { email: admin.email, password } })).status, 200);
  const cust = browser();
  const reg = await registerVerified({ base, mail, name: "Meena Iyer", email: `al-cust-${stamp}@example.test`, password });
  void reg;
  assert.equal((await cust("/api/auth/login", { method: "POST", body: { email: `al-cust-${stamp}@example.test`, password } })).status, 200);

  await check("B1 with no alert email the admin page says alerts are off", async () => {
    q("DELETE FROM app_settings WHERE key = 'alerts.email'");
    const page = await staff("/admin/settings/notifications");
    assert.equal(page.status, 200);
    assert.match(page.text, /Alerts are not active/);
    assert.match(page.text, /No alert email is set/);
  });

  await check("B2 an admin sets and updates the alert email; invalid input is refused", async () => {
    let r = await staff("/api/admin/notifications", { method: "PATCH", body: { alertEmail: "nope" } });
    assert.equal(r.status, 400);
    assert.ok(r.json.fields.alertEmail);
    r = await staff("/api/admin/notifications", { method: "PATCH", body: { alertEmail: "first@example.test" } });
    assert.equal(r.status, 200);
    r = await staff("/api/admin/notifications", { method: "PATCH", body: { alertEmail: "Owner@Example.test", graceMinutes: 30 } });
    assert.equal(r.json.alertEmail.email, "owner@example.test");
    assert.equal((await staff("/api/admin/notifications", { method: "PATCH", body: { graceMinutes: 2 } })).status, 400);
    const page = await staff("/admin/settings/notifications");
    assert.match(page.text, /Alerts are on — they go to owner@example\.test/);
    assert.match(page.text, /settings\.alerts_updated|owner@example\.test/);
  });

  await check("B3 customers and visitors cannot read or change alert settings", async () => {
    assert.equal((await cust("/api/admin/notifications", { method: "PATCH", body: { alertEmail: "evil@example.test" } })).status, 403);
    assert.equal((await browser()("/api/admin/notifications")).status, 401);
    assert.equal((await cust("/admin/settings/notifications")).status, 404);
    assert.equal((await cust("/api/admin/notifications/run", { method: "POST" })).status, 403);
  });

  await check("B4 the scheduler endpoint refuses anyone without the secret", async () => {
    const anon = browser();
    assert.equal((await anon("/api/internal/jobs/checkout-alerts", { method: "POST" })).status, 401);
    assert.equal((await anon("/api/internal/jobs/checkout-alerts", { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await anon("/api/internal/jobs/checkout-alerts", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}x` } })).status, 401);
    assert.equal((await anon("/api/internal/jobs/checkout-alerts")).status, 405);
    assert.equal((await staff("/api/internal/jobs/checkout-alerts", { method: "POST" })).status, 401, "an admin session is not the scheduler");
    const ok = await anon("/api/internal/jobs/checkout-alerts", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(ok.status, 200, ok.text);
  });

  const progress = (body) => cust("/api/checkout/progress", { method: "POST", body: { planId: "basic", currency: "INR", ...body } });
  let chk;
  await check("B5 checkout progress: valid details are saved with the catalogue price; invalid ones are not", async () => {
    let r = await progress({ billing: { name: "M", email: "bad", country: "IN", phone: "123" } });
    assert.equal(r.status, 400);
    assert.equal(q("SELECT COUNT(*) n FROM checkout_sessions WHERE billing_email = 'bad'")[0].n, 0);
    r = await progress({ billing: { name: "Meena Iyer", email: "meena@example.test", country: "IN", phone: "98765 43210" }, amountMinor: 1, amount: 1 });
    assert.equal(r.status, 200, r.text);
    chk = r.json.checkoutId;
    const [row] = q("SELECT * FROM checkout_sessions WHERE id = ?", chk);
    assert.deepEqual([row.amount_minor, row.currency, row.plan_id, row.status, row.billing_phone], [39900, "INR", "basic", "in_progress", "+919876543210"]);
    // Re-saving updates the same record.
    r = await progress({ checkoutId: chk, billing: { name: "Meena S Iyer", email: "meena@example.test", country: "IN", phone: "98765 43210" } });
    assert.equal(r.json.checkoutId, chk);
    assert.equal(q("SELECT billing_name FROM checkout_sessions WHERE id = ?", chk)[0].billing_name, "Meena S Iyer");
    // Someone else's record id cannot be written to.
    const other = browser();
    await registerVerified({ base, mail, name: "Other", email: `al-other-${stamp}@example.test`, password });
    await other("/api/auth/login", { method: "POST", body: { email: `al-other-${stamp}@example.test`, password } });
    const hijack = await other("/api/checkout/progress", { method: "POST", body: { checkoutId: chk, planId: "basic", billing: { name: "Mallory", email: "m@example.test", country: "IN", phone: "98765 43210" } } });
    assert.notEqual(hijack.json.checkoutId, chk, "a new record, not theirs");
    assert.equal(q("SELECT billing_name FROM checkout_sessions WHERE id = ?", chk)[0].billing_name, "Meena S Iyer");
    assert.equal((await browser()("/api/checkout/progress", { method: "POST", body: { planId: "basic" } })).status, 401);
  });

  await check("B6 end to end, no browser open: past the wait, the scheduler finds it and the email goes out", async () => {
    q("UPDATE checkout_sessions SET details_saved_at = details_saved_at - 31 * 60000 WHERE id = ?", chk);
    const sentBefore = mail.messages.length;
    const r = await browser()("/api/internal/jobs/checkout-alerts", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(r.status, 200);
    assert.ok(r.json.abandoned >= 1, r.text);
    const message = mail.messages.slice(sentBefore).find((m) => m.subject === "[AdSense Checker] Abandoned Checkout — Basic Plan");
    assert.ok(message, "delivered to the provider");
    assert.equal(message.to, "owner@example.test");
    assert.ok(message.text.includes("Meena S Iyer") && message.text.includes(chk));
  });

  await check("B7 pressing Pay (the order route) marks the checkout as a payment attempt", async () => {
    const r = await progress({ billing: { name: "Meena Iyer", email: "meena@example.test", country: "IN", phone: "98765 43210" } });
    const id = r.json.checkoutId;
    // No gateway is enabled in this database's production view, so the order is refused — but Pay was pressed.
    await cust("/api/checkout/order", { method: "POST", body: { planId: "basic", currency: "INR", checkoutId: id, attemptId: randomUUID(),
      billing: { name: "Meena Iyer", email: "meena@example.test", country: "IN", phone: "98765 43210" } } });
    assert.equal(q("SELECT status FROM checkout_sessions WHERE id = ?", id)[0].status, "payment_started");
    q("UPDATE checkout_sessions SET details_saved_at = details_saved_at - 3 * 3600000 WHERE id = ?", id);
    await browser()("/api/internal/jobs/checkout-alerts", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(q("SELECT COUNT(*) n FROM notifications WHERE checkout_id = ?", id)[0].n, 0);
  });

  await check("B8 the history lists alerts with delivery state, and failed ones can be retried", async () => {
    const page = await staff("/admin/settings/notifications");
    assert.match(page.text, /Alert history/);
    assert.match(page.text, /Abandoned checkout/);
    assert.match(page.text, /Payment failed/);
    assert.match(page.text, />Sent</);
    const failed = q("SELECT id FROM notifications WHERE status = 'sent' LIMIT 1")[0];
    const r = await staff(`/api/admin/notifications/${failed.id}/retry`, { method: "POST" });
    assert.equal(r.status, 409, "a sent alert is not re-sent");
    assert.equal((await cust(`/api/admin/notifications/${failed.id}/retry`, { method: "POST" })).status, 403);
  });

  assert.ok(!serverLog.includes(CRON_SECRET), "the scheduler secret never reaches the log");
  console.log(`payment & checkout alerts: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close();
  rmSync(workDir, { recursive: true, force: true });
}
