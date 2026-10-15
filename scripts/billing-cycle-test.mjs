// Phase 4: monthly and yearly billing.
//
//     npm run build && node scripts/billing-cycle-test.mjs
//
// Part A runs the real lib/ modules against stand-ins for the Razorpay and
// PayPal APIs (as pricing-test.mjs does): calendar-month dates, the
// discount formula, yearly offers, plan validation, monthly and yearly
// purchases in INR and USD through the real checkout and verification
// path, duplicate settlement, monthly allowance resets for yearly
// subscribers, scheduled renewal cycles and the V13 → V14 upgrade.
//
// Part B starts the production build on the same database and checks the
// pricing page switch, the checkout page, the order route's refusals, the
// admin pricing API and switch, and the billing page.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { compileLib } from "./lib/compile-lib.mjs";
import { isolatedServerEnv } from "./lib/server-env.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = { AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345", CREDENTIALS_SECRET: randomBytes(48).toString("base64") };
Object.assign(process.env, SECRETS, { NODE_ENV: "development" });
for (const name of [
  "PAYMENTS_MODE", "ADMIN_EMAIL", "ADMIN_PASSWORD",
  "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
  "CASHFREE_APP_ID", "CASHFREE_SECRET_KEY", "CASHFREE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID",
]) delete process.env[name];

const lib = compileLib(projectRoot, "aec-cycle-");
const dataDir = path.join(lib.workDir, "data");
process.env.DATA_DIR = dataDir;
const L = lib.require;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
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

/* ── stand-ins for the providers ────────────────────────────────── */

const calls = [];
const scenario = { razorpayPayment: null, paypalCapture: null };
let seq = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
  calls.push({ url, method: init.method ?? "GET", body });
  if (url === "https://api.razorpay.com/v1/orders") return json(200, { id: `order_rzp_${++seq}`, amount: body.amount, currency: body.currency });
  if (url.startsWith("https://api.razorpay.com/v1/payments/")) return json(200, scenario.razorpayPayment);
  if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: "pp_token", expires_in: 3600 });
  if (url.endsWith("/v2/checkout/orders")) return json(201, { id: `PP${++seq}`, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://paypal.test/approve" }] });
  if (/\/v2\/checkout\/orders\/[^/]+\/capture$/.test(url)) return json(201, scenario.paypalCapture);
  return json(404, { message: `no stub for ${url}` });
};
const lastBodyTo = (host) => calls.filter((c) => c.method === "POST" && c.url.includes(host) && /orders$/.test(c.url)).at(-1)?.body;

const cycle = L("./billing/cycle.js");
const { yearlyOffer, cyclePrice } = L("./billing/offer.js");
const yearlySettings = L("./billing/yearly-settings.js");
const accounts = L("./db/accounts.js");
const billing = L("./db/billing.js");
const { hashPasswordSync } = L("./auth/password.js");
const catalogue = L("./plan-catalogue.js");
const payments = L("./payments/index.js");
const cfg = L("./payments/config.js");
const site = L("./site-currency.js");
const { run, one, getDb } = L("./db/index.js");
const { MIGRATIONS } = L("./db/schema.js");

console.log("monthly & yearly billing");
getDb();

const IST = (y, m, d, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min) - (5 * 60 + 30) * 60_000;
const istDate = (ms) => new Date(ms + (5 * 60 + 30) * 60_000).toISOString().slice(0, 16).replace("T", " ");

/* ════════════════════ Part A — modules ════════════════════ */

await check("A1 calendar months in IST: month ends clamp, anchors never drift, leap years handled, time kept", () => {
  assert.equal(istDate(cycle.addCalendarMonths(IST(2026, 1, 31), 1)), "2026-02-28 12:00");
  assert.equal(istDate(cycle.addCalendarMonths(IST(2028, 1, 31), 1)), "2028-02-29 12:00", "leap year");
  assert.equal(istDate(cycle.addCalendarMonths(IST(2026, 1, 31), 2)), "2026-03-31 12:00", "from the anchor, not the 28th");
  assert.equal(istDate(cycle.addCalendarMonths(IST(2028, 2, 29), 12)), "2029-02-28 12:00");
  assert.equal(istDate(cycle.addCalendarMonths(IST(2026, 10, 14), 12)), "2027-10-14 12:00");
  assert.equal(istDate(cycle.addCalendarMonths(IST(2026, 1, 31, 23, 30), 1)), "2026-02-28 23:30", "late-night IST purchase stays on its IST day");
  assert.equal(istDate(cycle.addCalendarMonths(IST(2026, 12, 15), 1)), "2027-01-15 12:00", "year rollover");
  assert.equal(istDate(cycle.periodEnd(IST(2026, 3, 31), "yearly")), "2027-03-31 12:00");
  assert.equal(istDate(cycle.periodEnd(IST(2026, 3, 31), "monthly")), "2026-04-30 12:00");
});

await check("A2 discount = floor((1 − yearly ÷ (monthly × 12)) × 100); missing, zero, invalid or no saving → none", () => {
  assert.equal(cycle.yearlyDiscountPercent(39900, 399000), 16, "₹399/mo vs ₹3,990/yr → 16.67% → 16");
  assert.equal(cycle.yearlyDiscountPercent(1000, 10000), 16);
  assert.equal(cycle.yearlyDiscountPercent(1000, 6000), 50);
  assert.equal(cycle.yearlyDiscountPercent(1000, 12000), null, "same as monthly");
  assert.equal(cycle.yearlyDiscountPercent(1000, 13000), null, "dearer than monthly");
  assert.equal(cycle.yearlyDiscountPercent(1000, 11950), null, "under 1% is not advertised");
  for (const [m, y] of [[null, 100], [100, null], [0, 100], [100, 0], [-5, 10], [10.5, 50], [undefined, 100]]) {
    assert.equal(cycle.yearlyDiscountPercent(m, y), null, `${m}/${y}`);
  }
  assert.equal(cycle.monthlyEquivalent(399000), 33250);
});

const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = accounts.createUser({ name: "Admin", email: `bc-admin-${stamp}@example.test`, passwordHash: hashPasswordSync(password), role: "admin" });
const buyer = accounts.createUser({ name: "Buyer", email: `bc-buyer-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
const actor = { id: admin.id, email: admin.email };

await check("A3 existing plans stay monthly-only: no yearly price, switch off, nothing offered", () => {
  for (const plan of catalogue.listPlans()) {
    assert.deepEqual([plan.yearlyAmountPaise, plan.yearlyUsdCents, plan.yearlyEnabled, plan.yearlyBadge], [null, null, false, null], plan.id);
    assert.equal(yearlyOffer(plan, "INR", true), null);
  }
  assert.equal(yearlySettings.yearlyBillingEnabled(), false, "off until an admin turns it on");
});

await check("A4 yearly prices are validated: Free never, zero/negative/fractional refused, badge ≤ 40, audit lines written", () => {
  assert.equal(catalogue.updatePlan("free", { yearlyAmountPaise: 100 }, actor).ok, false);
  assert.equal(catalogue.updatePlan("free", { yearlyEnabled: true }, actor).ok, false);
  assert.equal(catalogue.updatePlan("basic", { yearlyAmountPaise: 0 }, actor).ok, false);
  assert.equal(catalogue.updatePlan("basic", { yearlyAmountPaise: -100 }, actor).ok, false);
  assert.equal(catalogue.updatePlan("basic", { yearlyUsdCents: 99.5 }, actor).ok, false);
  assert.equal(catalogue.updatePlan("basic", { yearlyBadge: "x".repeat(41) }, actor).ok, false);
  catalogue.updatePlan("basic", { usdAmountCents: 599 }, actor);
  const r = catalogue.updatePlan("basic", { yearlyAmountPaise: 399000, yearlyUsdCents: 5990, yearlyEnabled: true, yearlyBadge: " 2 months free " }, actor);
  assert.ok(r.ok, r.error);
  assert.deepEqual([r.after.yearlyAmountPaise, r.after.yearlyUsdCents, r.after.yearlyEnabled, r.after.yearlyBadge], [399000, 5990, true, "2 months free"]);
  assert.equal(r.after.amountPaise, 39900, "monthly INR untouched");
  assert.ok(r.changed.some((c) => /yearly INR price not offered → ₹3,990/.test(c)), r.changed.join("; "));
  assert.ok(r.changed.includes("yearly billing on"));
});

await check("A5 a yearly offer needs the site switch, the plan switch, a price in the currency, and a plan on sale", () => {
  const basic = catalogue.requirePlan("basic");
  assert.equal(yearlyOffer(basic, "INR", false), null, "site switch off");
  assert.deepEqual(yearlyOffer(basic, "INR", true), { price: 399000, perMonth: 33250, discount: 16, badge: "2 months free" });
  assert.deepEqual(yearlyOffer(basic, "USD", true), { price: 5990, perMonth: 499, discount: 16, badge: "2 months free" });
  assert.equal(yearlyOffer({ ...basic, purchasable: false }, "INR", true), null);
  assert.equal(yearlyOffer({ ...basic, yearlyEnabled: false }, "INR", true), null);
  assert.equal(yearlyOffer(catalogue.requirePlan("pro"), "INR", true), null, "Pro has no yearly price");
  assert.equal(cyclePrice(basic, "INR", "monthly", false), 39900, "monthly never depends on the yearly switch");
  assert.equal(cyclePrice(basic, "INR", "yearly", false), null);
  assert.equal(cyclePrice(basic, "EUR", "yearly", true), null);
});

cfg.saveGatewayCredentials({ id: "razorpay", values: { keyId: "rzp_test_abc", keySecret: "rzp_secret_xyz", webhookSecret: "rzp_wh" }, enabled: true, actorEmail: admin.email });
cfg.saveGatewayCredentials({ id: "paypal", values: { clientId: "pp_client", clientSecret: "pp_secret", webhookId: "pp_wh" }, enabled: true, actorEmail: admin.email });
const billingDetails = { name: "Asha Buyer", email: "asha@example.test", phone: "+919876543210", country: "IN" };
const open = (planId, currency, gateway, billingCycle) =>
  payments.startCheckout({
    userId: buyer.id, plan: catalogue.requirePlan(planId), currency, gateway, billingCycle,
    customerName: "Asha", customerEmail: "asha@example.test", billing: billingDetails,
    returnUrl: "http://127.0.0.1/dashboard/billing/return", idempotencyKey: randomUUID(),
  });
const rzpSign = (orderId, paymentId) => createHmac("sha256", "rzp_secret_xyz").update(`${orderId}|${paymentId}`).digest("hex");
async function payRazorpay(order, paymentId) {
  scenario.razorpayPayment = { id: paymentId, order_id: order.orderId, status: "captured", amount: order.amountPaise, currency: order.currency, method: "upi" };
  return payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId, payload: { razorpay_order_id: order.orderId, razorpay_payment_id: paymentId, razorpay_signature: rzpSign(order.orderId, paymentId) } });
}
async function payPaypal(order, value) {
  const custom = lastBodyTo("paypal").purchase_units[0].custom_id;
  scenario.paypalCapture = { id: order.orderId, status: "COMPLETED", purchase_units: [{ amount: { currency_code: "USD", value }, payments: { captures: [{ id: `CAP${++seq}`, status: "COMPLETED", custom_id: custom, amount: { currency_code: "USD", value } }] } }] };
  return payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId, payload: { token: order.orderId } });
}

await check("A6 a yearly order is refused while yearly billing is off, or with an unknown cycle — before any provider call", async () => {
  const before = calls.length;
  const off = await open("basic", "INR", "razorpay", "yearly");
  assert.equal(off.code, "PRICE_NOT_CONFIGURED");
  assert.match(off.message, /yearly/);
  const bogus = await open("basic", "INR", "razorpay", "weekly");
  assert.equal(bogus.code, "VALIDATION_ERROR");
  assert.equal(calls.length, before);
  yearlySettings.setYearlyBillingEnabled(true, admin.email);
  const pro = await open("pro", "INR", "razorpay", "yearly");
  assert.equal(pro.code, "PRICE_NOT_CONFIGURED", "Pro has no yearly price");
});

let monthlyInrSub;
await check("A7 monthly INR purchase: ₹399 sent, 1 calendar month, recorded as monthly with calendar billing", async () => {
  const order = await open("basic", "INR", "razorpay", "monthly");
  assert.ok(order.ok, order.message);
  assert.deepEqual([order.amountPaise, order.billingCycle, lastBodyTo("razorpay").amount], [39900, "monthly", 39900]);
  const t0 = Date.now();
  const r = await payRazorpay(order, "pay_m1");
  assert.ok(r.ok, r.message);
  monthlyInrSub = billing.findSubscription(r.subscriptionId);
  assert.equal(monthlyInrSub.billingCycle, "monthly");
  assert.equal(monthlyInrSub.calendarBilling, true);
  assert.ok(Math.abs(monthlyInrSub.expiresAt - cycle.addCalendarMonths(monthlyInrSub.startsAt, 1)) === 0 && monthlyInrSub.startsAt >= t0);
  assert.equal(monthlyInrSub.cycleEnd, monthlyInrSub.expiresAt);
});

let yearlyInrSub;
await check("A8 yearly INR purchase: ₹3,990 from the plan record, 12 months, monthly allowance, yearly invoice", async () => {
  const order = await open("basic", "INR", "razorpay", "yearly");
  assert.ok(order.ok, order.message);
  assert.deepEqual([order.amountPaise, order.currency, order.billingCycle], [399000, "INR", "yearly"]);
  assert.equal(lastBodyTo("razorpay").amount, 399000);
  const payment = billing.findPaymentByOrderId(order.orderId);
  assert.equal(payment.billingCycle, "yearly");
  const r = await payRazorpay(order, "pay_y1");
  assert.ok(r.ok, r.message);
  yearlyInrSub = billing.findSubscription(r.subscriptionId);
  assert.deepEqual([yearlyInrSub.billingCycle, yearlyInrSub.amountPaise, yearlyInrSub.currency], ["yearly", 399000, "INR"]);
  assert.equal(yearlyInrSub.expiresAt, cycle.addCalendarMonths(yearlyInrSub.startsAt, 12));
  assert.equal(yearlyInrSub.cycleEnd, cycle.addCalendarMonths(yearlyInrSub.startsAt, 1), "scans still reset monthly");
  assert.equal(yearlyInrSub.scanLimit, catalogue.requirePlan("basic").scanLimit, "a monthly allowance, not ×12");
  assert.equal(billing.findSubscription(monthlyInrSub.id).status, "cancelled", "the new plan supersedes the old one, as before");
  const invoice = billing.findInvoiceByPayment(payment.id);
  assert.deepEqual([invoice.billingCycle, invoice.amountPaise, invoice.planName], ["yearly", 399000, "Basic"]);
  assert.equal(invoice.periodEnd, yearlyInrSub.expiresAt);
});

await check("A9 a repeated confirmation of a yearly payment grants nothing more", async () => {
  const before = one("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?", [buyer.id]).n;
  const order = billing.findPaymentByOrderId(billing.findSubscription(yearlyInrSub.id).orderId);
  const again = await payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId, payload: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_y1", razorpay_signature: rzpSign(order.orderId, "pay_y1") } });
  assert.equal(again.ok && again.status, "already");
  assert.equal(one("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?", [buyer.id]).n, before);
});

await check("A10 a payment for the monthly amount on a yearly order is refused (amount mismatch)", async () => {
  const order = await open("basic", "INR", "razorpay", "yearly");
  scenario.razorpayPayment = { id: "pay_bad", order_id: order.orderId, status: "captured", amount: 39900, currency: "INR", method: "upi" };
  const r = await payments.verifyCheckout({ userId: buyer.id, orderId: order.orderId, payload: { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_bad", razorpay_signature: rzpSign(order.orderId, "pay_bad") } });
  assert.equal(r.ok, false);
  assert.match(r.message, /amount/);
});

await check("A11 a repeated attempt replays only with the same cycle; a different cycle is refused", async () => {
  const key = randomUUID();
  const base = { userId: buyer.id, plan: catalogue.requirePlan("basic"), currency: "INR", gateway: "razorpay", customerName: "Asha", customerEmail: "a@example.test", billing: billingDetails, returnUrl: "http://127.0.0.1/r", idempotencyKey: key };
  const first = await payments.startCheckout({ ...base, billingCycle: "yearly" });
  const same = await payments.startCheckout({ ...base, billingCycle: "yearly" });
  assert.equal(same.replayed, true);
  assert.equal(same.orderId, first.orderId);
  const other = await payments.startCheckout({ ...base, billingCycle: "monthly" });
  assert.equal(other.code, "CHECKOUT_ATTEMPT_USED");
});

await check("A12 monthly and yearly USD purchases through PayPal: $5.99 and $59.90, recorded in USD", async () => {
  const monthly = await open("basic", "USD", "paypal", "monthly");
  assert.deepEqual(lastBodyTo("paypal").purchase_units[0].amount, { currency_code: "USD", value: "5.99" });
  let r = await payPaypal(monthly, "5.99");
  assert.ok(r.ok, r.message);
  assert.deepEqual([billing.findSubscription(r.subscriptionId).billingCycle, billing.findSubscription(r.subscriptionId).amountPaise], ["monthly", 599]);
  const yearly = await open("basic", "USD", "paypal", "yearly");
  assert.ok(yearly.ok, yearly.message);
  assert.deepEqual(lastBodyTo("paypal").purchase_units[0].amount, { currency_code: "USD", value: "59.90" });
  assert.match(lastBodyTo("paypal").purchase_units[0].description, /12 months/);
  r = await payPaypal(yearly, "59.90");
  assert.ok(r.ok, r.message);
  const sub = billing.findSubscription(r.subscriptionId);
  assert.deepEqual([sub.billingCycle, sub.amountPaise, sub.currency], ["yearly", 5990, "USD"]);
});

await check("A13 yearly subscribers' allowance resets every calendar month, catching up gaps, ending with the year", () => {
  const user = accounts.createUser({ name: "Y", email: `bc-y-${stamp}@example.test`, passwordHash: "x" });
  const start = IST(2026, 1, 31, 10);
  const sub = billing.createSubscription({ userId: user.id, plan: catalogue.requirePlan("basic"), paymentStatus: "paid", billingCycle: "yearly", now: start });
  run("UPDATE subscriptions SET scans_used = 7 WHERE id = ?", [sub.id]);
  billing.rollBillingCycles(IST(2026, 2, 27));
  assert.equal(billing.findSubscription(sub.id).scansUsed, 7, "not before the month ends");
  billing.rollBillingCycles(IST(2026, 3, 1));
  let s = billing.findSubscription(sub.id);
  assert.deepEqual([s.scansUsed, s.cycleIndex, istDate(s.cycleStart), istDate(s.cycleEnd)], [0, 2, "2026-02-28 10:00", "2026-03-31 10:00"]);
  run("UPDATE subscriptions SET scans_used = 3 WHERE id = ?", [sub.id]);
  billing.rollBillingCycles(IST(2026, 7, 2)); // nobody read it for months
  s = billing.findSubscription(sub.id);
  assert.deepEqual([s.scansUsed, s.cycleIndex, istDate(s.cycleEnd)], [0, 6, "2026-07-31 10:00"]);
  billing.rollBillingCycles(IST(2027, 1, 15));
  s = billing.findSubscription(sub.id);
  assert.equal(s.cycleEnd, s.expiresAt, "the last month ends with the subscription");
  assert.equal(istDate(s.expiresAt), "2027-01-31 10:00");
});

await check("A14 subscriptions sold before calendar billing keep their 30-day cycles", () => {
  const user = accounts.createUser({ name: "L", email: `bc-l-${stamp}@example.test`, passwordHash: "x" });
  const sub = billing.createSubscription({ userId: user.id, plan: catalogue.requirePlan("basic"), paymentStatus: "paid" });
  const t = Date.now() - 40 * 86_400_000;
  run("UPDATE subscriptions SET calendar_billing = 0, starts_at = ?, cycle_start = ?, cycle_end = ?, expires_at = ?, scans_used = 4 WHERE id = ?", [t, t, t + 30 * 86_400_000, t + 90 * 86_400_000, sub.id]);
  billing.rollBillingCycles();
  const s = billing.findSubscription(sub.id);
  assert.equal(s.cycleEnd, t + 60 * 86_400_000, "+30 days, as sold");
  assert.equal(s.scansUsed, 0);
  assert.equal(s.calendarBilling, false);
});

await check("A15 a switch to yearly can be scheduled for renewal: own active plan only, nothing charged, period unchanged", async () => {
  const user = accounts.createUser({ name: "S", email: `bc-s-${stamp}@example.test`, passwordHash: "x" });
  const sub = billing.createSubscription({ userId: user.id, plan: catalogue.requirePlan("basic"), paymentStatus: "paid" });
  const paymentsBefore = one("SELECT COUNT(*) AS n FROM payments").n;
  assert.equal(billing.setNextBillingCycle({ subscriptionId: sub.id, userId: buyer.id, cycle: "yearly" }), false, "not someone else's");
  assert.equal(billing.setNextBillingCycle({ subscriptionId: sub.id, userId: user.id, cycle: "yearly" }), true);
  const s = billing.findSubscription(sub.id);
  assert.deepEqual([s.nextBillingCycle, s.billingCycle, s.expiresAt], ["yearly", "monthly", sub.expiresAt]);
  assert.equal(one("SELECT COUNT(*) AS n FROM payments").n, paymentsBefore);
  billing.setNextBillingCycle({ subscriptionId: sub.id, userId: user.id, cycle: null });
  assert.equal(billing.findSubscription(sub.id).nextBillingCycle, null);
});

await check("A16 migration V14 applies to a version-13 database; old rows read as monthly, 30-day, no yearly price", () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS.slice(0, 13)) db.exec(sql);
  db.prepare("INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES ('u', 'U', 'u@x.test', 'h', 1, 1)").run();
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_id, plan_name, amount_paise, scan_limit, validity_days, purchased_at, starts_at, expires_at, status, payment_status, created_at, updated_at)
              VALUES ('s', 'u', 'basic', 'Basic', 39900, 100, 30, 1, 1, 2, 'active', 'paid', 1, 1)`).run();
  db.exec(MIGRATIONS[13]);
  assert.ok(MIGRATIONS.length >= 14);
  const row = db.prepare("SELECT billing_cycle, calendar_billing, next_billing_cycle FROM subscriptions WHERE id = 's'").get();
  assert.deepEqual({ ...row }, { billing_cycle: "monthly", calendar_billing: 0, next_billing_cycle: null });
  assert.throws(() => db.prepare("UPDATE subscriptions SET billing_cycle = 'weekly'").run(), "cycle is constrained");
  db.close();
});

/* ════════════════════ Part B — over HTTP ════════════════════ */

globalThis.fetch = realFetch;
site.setSiteCurrency("INR", "test");
// Back to a known state for the pages: buyer on Basic monthly, paid.
const pageBuyer = accounts.createUser({ name: "Page Buyer", email: `bc-page-${stamp}@example.test`, passwordHash: hashPasswordSync(password) });
billing.createSubscription({ userId: pageBuyer.id, plan: catalogue.requirePlan("basic"), paymentStatus: "paid", amountPaise: 39900, currency: "INR" });

const port = 5700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: projectRoot,
  env: isolatedServerEnv({ ...process.env, ...SECRETS, NODE_ENV: "production", DATA_DIR: dataDir, CHECKOUT_ALERTS_BACKGROUND: "off", ML_BACKGROUND: "off", RESCANS_BACKGROUND: "off", NEXT_PUBLIC_APP_URL: base }),
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function call(pathname, { method = "GET", body, cookie } = {}) {
  const headers = new Headers({ "x-forwarded-for": `198.51.100.${(seq % 200) + 1}` });
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET") headers.set("origin", base);
  if (body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = (await res.text()).replace(/<!-- -->/g, "");
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json: data, text, setCookie: res.headers.getSetCookie() };
}
async function login(email) {
  const r = await call("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(r.status, 200, `login ${email}: ${r.text.slice(0, 200)}`);
  return r.setCookie.map((c) => c.split(";")[0]).join("; ");
}

try {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await realFetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const adminCookie = await login(admin.email);
  const buyerCookie = await login(pageBuyer.email);

  await check("B1 the admin switch and yearly prices are admin-only and audited", async () => {
    assert.equal((await call("/api/admin/pricing/yearly", { method: "PATCH", body: { enabled: false }, cookie: buyerCookie })).status, 403);
    assert.equal((await call("/api/admin/pricing/yearly", { method: "PATCH", body: { enabled: "yes" }, cookie: adminCookie })).status, 400);
    assert.equal((await call("/api/admin/pricing/yearly", { method: "PATCH", body: { enabled: false }, cookie: adminCookie })).json.enabled, false);
    assert.equal((await call("/api/admin/pricing/basic", { method: "PATCH", body: { yearlyInr: "0" }, cookie: adminCookie })).status, 400);
    const ask = await call("/api/admin/pricing/pro", { method: "PATCH", body: { yearlyInr: "9990", yearlyEnabled: true }, cookie: adminCookie });
    assert.equal(ask.json.code, "CONFIRMATION_REQUIRED");
    assert.match(ask.json.summary, /yearly INR not offered → ₹9,990; yearly billing on/);
    const saved = await call("/api/admin/pricing/pro", { method: "PATCH", body: { yearlyInr: "9990", yearlyEnabled: true, confirmed: true }, cookie: adminCookie });
    assert.equal(saved.status, 200, saved.text.slice(0, 200));
    assert.ok(one("SELECT * FROM admin_logs WHERE action = 'billing.yearly_toggled'"));
    const page = await call("/admin/pricing", { cookie: adminCookie });
    assert.ok(page.text.includes("Enable yearly billing") && page.text.includes("Monthly + yearly") && page.text.includes("save 16%"));
  });

  await check("B2 with yearly billing off, the pricing page and checkout stay monthly-only", async () => {
    const page = await call("/pricing");
    assert.ok(!page.text.includes('aria-label="Billing period"'), "no switch");
    assert.ok(page.text.includes("/month"));
    const checkout = await call("/checkout?plan=pro&cycle=yearly", { cookie: buyerCookie });
    assert.ok(checkout.text.includes("isn&#x27;t offered yearly right now") || checkout.text.includes("isn't offered yearly right now"));
  });

  await check("B3 with it on, the switch appears with yearly prices, the saving and the badge; Free stays free", async () => {
    await call("/api/admin/pricing/yearly", { method: "PATCH", body: { enabled: true }, cookie: adminCookie });
    const page = await call("/pricing");
    assert.ok(page.text.includes('aria-label="Billing period"'));
    for (const text of ["Save up to 16%", "₹3,990", "/year", "2 months free", "≈ ₹332.50/month, billed yearly", "₹9,990"]) assert.ok(page.text.includes(text), text);
    assert.ok(page.text.includes("cycle%3Dyearly") || page.text.includes("cycle=yearly"), "yearly links carry the cycle");
    assert.ok(page.text.includes("₹0"), "Free stays free in both modes");
    assert.ok(!page.text.includes("₹0/year") && !/₹0<\/span><span[^>]*>\/year/.test(page.text), "never a ₹0 yearly price");
    const home = await call("/");
    assert.ok(home.text.includes('aria-label="Billing period"'), "homepage pricing too");
  });

  await check("B4 the yearly checkout page shows 12 months, the monthly equivalent and the allowance note", async () => {
    const page = await call("/checkout?plan=pro&cycle=yearly", { cookie: buyerCookie });
    for (const text of ["Yearly", "12 months of access", "₹9,990", "billed yearly", "Your scan allowance still resets every month"]) assert.ok(page.text.includes(text), text);
  });

  await check("B5 the order route takes no price from the browser and refuses a stale or unknown cycle", async () => {
    const billingBody = { name: "Page Buyer", email: "pb@example.test", phone: "9876543210", country: "IN" };
    const wrong = await call("/api/checkout/order", { method: "POST", cookie: buyerCookie, body: { planId: "pro", billingCycle: "yearly", currency: "INR", expectedAmount: 99900, billing: billingBody, attemptId: randomUUID() } });
    assert.equal(wrong.json.code, "PRICE_CHANGED", "the monthly amount shown can't buy a year");
    const bad = await call("/api/checkout/order", { method: "POST", cookie: buyerCookie, body: { planId: "pro", billingCycle: "forever", billing: billingBody, attemptId: randomUUID() } });
    assert.equal(bad.status, 400);
    await call("/api/admin/pricing/yearly", { method: "PATCH", body: { enabled: false }, cookie: adminCookie });
    const off = await call("/api/checkout/order", { method: "POST", cookie: buyerCookie, body: { planId: "pro", billingCycle: "yearly", currency: "INR", expectedAmount: 999000, billing: billingBody, attemptId: randomUUID() } });
    assert.equal(off.json.code, "PRICE_NOT_CONFIGURED");
    await call("/api/admin/pricing/yearly", { method: "PATCH", body: { enabled: true }, cookie: adminCookie });
  });

  await check("B6 the billing page shows the cycle and schedules a yearly renewal without charging", async () => {
    let page = await call("/dashboard/billing", { cookie: buyerCookie });
    for (const text of ["Billing cycle", "Monthly price", "Switch to yearly at renewal", "₹3,990/year · save 16%"]) assert.ok(page.text.includes(text), text);
    const before = one("SELECT COUNT(*) AS n FROM payments").n;
    const r = await call("/api/account/billing-cycle", { method: "POST", cookie: buyerCookie, body: { cycle: "yearly" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.nextBillingCycle, "yearly");
    assert.equal(one("SELECT COUNT(*) AS n FROM payments").n, before, "nothing charged");
    page = await call("/dashboard/billing", { cookie: buyerCookie });
    assert.ok(page.text.includes("Switching to yearly billing at renewal"));
    assert.ok(page.text.includes("→ yearly at renewal"));
    assert.equal((await call("/api/account/billing-cycle", { method: "POST", cookie: buyerCookie, body: { cycle: "fortnightly" } })).status, 400);
    assert.equal((await call("/api/account/billing-cycle", { method: "POST", body: { cycle: "yearly" } })).status, 401);
    const same = await call("/checkout?plan=basic&cycle=yearly", { cookie: buyerCookie });
    assert.ok(same.text.includes("schedule it on your billing page"), "the same plan isn't sold twice; switching is scheduled");
  });

  await check("B7 nothing secret or broken reached the server log", () => {
    assert.ok(!serverLog.includes("rzp_secret_xyz") && !serverLog.includes("pp_secret"));
    assert.ok(!/TypeError|ReferenceError|SqliteError/.test(serverLog), serverLog.slice(-500));
  });

  console.log(`monthly & yearly billing: passed (${passed} checks)`);
} finally {
  server.kill();
  lib.cleanup();
}
process.exit(0);
