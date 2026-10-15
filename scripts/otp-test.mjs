// Unified login + email-code verification, against a real `next start`
// build, a throwaway database and a stand-in for the Resend API (the app's
// real Resend provider sends to it — see scripts/lib/mail-sink.mjs).
//
// Run after `npm run build`:  node scripts/otp-test.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { registerVerified, startMailSink } from "./lib/mail-sink.mjs";
import { isolatedServerEnv } from "./lib/server-env.mjs";

const SECRET = "test-auth-secret-that-is-long-enough-to-be-safe-12345";
const dataDir = await mkdtemp(path.join(tmpdir(), "aec-otp-"));
const port = 4100 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = { email: `admin-${stamp}@example.test`, password: "Adm1n-Password!" };
const mail = await startMailSink();
let passed = 0;
let serverLog = "";

/* ── plumbing ───────────────────────────────────────────────────── */

function startServer(p, extraEnv) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(p)], {
    cwd: process.cwd(),
    env: isolatedServerEnv({
      ...process.env,
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      AUTH_SECRET: SECRET,
      ADMIN_EMAIL: admin.email,
      ADMIN_PASSWORD: admin.password,
      ...extraEnv,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Everything the server prints is kept, to prove no code ever reaches it.
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));
  return child;
}

async function waitFor(url) {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Each scenario speaks from its own client address, so the per-IP limits
// (which are under test themselves) don't bleed between scenarios.
let ipSeq = 0;
const newIp = () => `203.0.113.${(ipSeq += 1)}`;

async function call(pathname, { method = "GET", body, cookie, ip = "198.51.100.1", root = base } = {}) {
  const headers = new Headers({ "x-forwarded-for": ip });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", root);
  } else if (method !== "GET") {
    headers.set("origin", root);
  }
  const res = await fetch(`${root}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { res, status: res.status, text, json, cookies: res.headers.getSetCookie() };
}

const cookieNamed = (r, name) => r.cookies.find((c) => c.startsWith(`${name}=`));
const pair = (raw) => raw?.split(";", 1)[0];
const location = (r) => decodeURIComponent(r.res.headers.get("location") ?? "");

function db() {
  const handle = new DatabaseSync(path.join(dataDir, "app.db"));
  handle.exec("PRAGMA busy_timeout = 5000");
  return handle;
}
function q(sql, ...args) {
  const handle = db();
  try {
    return handle.prepare(sql).all(...args);
  } finally {
    handle.close();
  }
}
const users = (email) => q("SELECT * FROM users WHERE email = ?", email);
const pending = (email) => q("SELECT * FROM pending_registrations WHERE email = ?", email)[0];
/** Lets a test skip the 60-second resend cooldown without waiting it out. */
const skipCooldown = (email) =>
  q("UPDATE pending_registrations SET last_sent_at = last_sent_at - 61000 WHERE email = ? RETURNING email", email);

async function startSignup(label, extra = {}) {
  const email = `${label}-${stamp}@example.test`;
  const ip = newIp();
  const r = await call("/api/auth/signup", {
    method: "POST",
    ip,
    body: { name: `Test ${label}`, email, password, confirmPassword: password, ...extra },
  });
  return { email, ip, r, verifyCookie: pair(cookieNamed(r, "aec_verify")) };
}

const verify = (flow, code, ip = flow.ip) =>
  call("/api/auth/verify-email", { method: "POST", ip, cookie: flow.verifyCookie, body: { code } });

const resend = (flow) => call("/api/auth/resend-verification", { method: "POST", ip: flow.ip, cookie: flow.verifyCookie });

const login = (email, pw, extra = {}, ip = newIp()) =>
  call("/api/auth/login", { method: "POST", ip, body: { email, password: pw, ...extra } });

const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

/* ── run ────────────────────────────────────────────────────────── */

let server = startServer(port, mail.env);

try {
  await waitFor(`${base}/pricing`);
  console.log("unified login & email verification");

  const alice = await registerVerified({ base, mail, name: "Alice", email: `alice-${stamp}@example.test`, password });
  const aliceEmail = `alice-${stamp}@example.test`;

  /* ── unified login ─────────────────────────────────────────── */

  await check("1  a customer logs in at /api/auth/login and is sent to the dashboard", async () => {
    const r = await login(aliceEmail, password);
    assert.equal(r.status, 200);
    assert.equal(r.json.redirectTo, "/dashboard");
    assert.ok(cookieNamed(r, "aec_session"));
  });

  await check("2  an administrator logs in through the same endpoint and page", async () => {
    const page = await call("/login");
    assert.equal(page.status, 200);
    assert.match(page.text, /name="password"/);
    assert.doesNotMatch(page.text, /name="role"|value="admin"/i, "no role selector");
    const r = await login(admin.email, admin.password);
    assert.equal(r.status, 200);
    assert.equal(r.json.redirectTo, "/admin");
  });

  await check("3  the destination follows the server-side role, never the request", async () => {
    // A customer cannot talk their way to the panel…
    const forged = await login(aliceEmail, password, { role: "admin", isAdmin: true, next: "/admin" });
    assert.equal(forged.json.redirectTo, "/dashboard");
    const session = await call("/api/auth/session", { cookie: pair(cookieNamed(forged, "aec_session")) });
    assert.equal(session.json.user.isAdmin, false);
    // …an admin's requested admin page is honoured…
    const adm = await login(admin.email, admin.password, { next: "/admin/users" });
    assert.equal(adm.json.redirectTo, "/admin/users");
    // …and an already signed-in visitor opening /login is forwarded by role.
    const adminCookie = pair(cookieNamed(adm, "aec_session"));
    assert.equal(location(await call("/login", { cookie: adminCookie })), "/admin");
    assert.equal(location(await call("/login", { cookie: alice.cookie })), "/dashboard");
  });

  await check("4  a wrong password is rejected with a generic message", async () => {
    const r = await login(aliceEmail, "Wrong-Password-1!");
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "INVALID_CREDENTIALS");
    assert.ok(!cookieNamed(r, "aec_session"));
    const nobody = await login(`nobody-${stamp}@example.test`, "Wrong-Password-1!");
    assert.equal(nobody.json.message, r.json.message, "unknown address looks the same");
  });

  await check("5  a suspended account cannot log in", async () => {
    const s = await registerVerified({ base, mail, name: "Sus", email: `sus-${stamp}@example.test`, password });
    q("UPDATE users SET status = 'blocked', blocked_reason = 'Test.' WHERE email = ? RETURNING id", `sus-${stamp}@example.test`);
    const r = await login(`sus-${stamp}@example.test`, password);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "ACCOUNT_BLOCKED");
    assert.ok(!cookieNamed(r, "aec_session"));
    assert.ok(s.cookie);
  });

  await check("6  an unconfirmed sign-up has no account, no session and no way in", async () => {
    const flow = await startSignup("unverified");
    assert.equal(flow.r.status, 202);
    assert.ok(!cookieNamed(flow.r, "aec_session"), "sign-up starts no session");
    assert.equal(users(flow.email).length, 0, "no users row before the code");
    assert.equal((await call("/dashboard", { cookie: flow.verifyCookie })).status, 307);
    // The right password at login only sends them back to verify.
    const r = await login(flow.email, password);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "EMAIL_NOT_VERIFIED");
    assert.equal(r.json.redirectTo, "/verify-email");
    assert.ok(!cookieNamed(r, "aec_session"));
    // The wrong password gets the ordinary answer.
    assert.equal((await login(flow.email, "Wrong-Password-1!")).json.code, "INVALID_CREDENTIALS");
  });

  await check("7  a customer cannot open admin pages or call admin APIs", async () => {
    assert.equal((await call("/admin", { cookie: alice.cookie })).status, 404);
    assert.equal((await call("/admin/users", { cookie: alice.cookie })).status, 404);
    const api = await call("/api/admin/profile", { method: "POST", cookie: alice.cookie, body: { name: "x" } });
    assert.equal(api.status, 403);
    assert.equal(api.json.code, "ADMIN_REQUIRED");
  });

  await check("8  protected pages keep their destination; unsafe destinations are dropped", async () => {
    assert.equal(location(await call("/admin")), "/login?next=/admin");
    assert.equal(location(await call("/dashboard/billing")), "/login?next=/dashboard/billing");
    for (const evil of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      assert.equal((await login(aliceEmail, password, { next: evil })).json.redirectTo, "/dashboard");
    }
    assert.equal((await login(aliceEmail, password, { next: "/verify-email" })).json.redirectTo, "/dashboard");
  });

  await check("9  sessions survive refreshes; logout ends them; remember-me controls the cookie", async () => {
    const remembered = await login(aliceEmail, password);
    const raw = cookieNamed(remembered, "aec_session");
    assert.match(raw, /Expires=/i, "remembered: a 30-day cookie");
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    const cookie = pair(raw);
    for (let i = 0; i < 3; i += 1) assert.equal((await call("/dashboard", { cookie })).status, 200);
    const page = await call("/dashboard", { cookie });
    assert.match(page.res.headers.get("cache-control") ?? "", /no-store/, "not kept for the back button");

    const brief = await login(aliceEmail, password, { remember: false });
    assert.doesNotMatch(cookieNamed(brief, "aec_session"), /Expires=|Max-Age=/i, "unticked: a browser-session cookie");
    assert.equal((await call("/dashboard", { cookie: pair(cookieNamed(brief, "aec_session")) })).status, 200);

    const out = await call("/api/auth/logout", { method: "POST", cookie });
    assert.equal(out.status, 200);
    assert.match(cookieNamed(out, "aec_session"), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    assert.equal((await call("/dashboard", { cookie })).status, 307, "the old cookie is dead server-side");
    assert.equal((await call("/api/auth/session", { cookie })).json.user, null);
  });

  /* ── email codes ───────────────────────────────────────────── */

  let ten;
  await check("10 sign-up issues a code: stored only as a hash, never in the response", async () => {
    ten = await startSignup("ten", { role: "admin", isAdmin: true });
    assert.equal(ten.r.status, 202);
    assert.equal(ten.r.json.verification.redirectTo, "/verify-email");
    const code = mail.latestCode(ten.email);
    assert.match(code, /^\d{6}$/);
    assert.ok(!ten.r.text.includes(code), "code not in the response");
    assert.ok(!ten.r.cookies.join(";").includes(code), "code not in a cookie");
    const row = pending(ten.email);
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes(code), "code not stored in plain text");
    assert.ok(row.code_expires_at - Date.now() <= 10 * 60 * 1000 && row.code_expires_at > Date.now() + 9 * 60 * 1000);
  });

  await check("11 the email reaches the provider with the code, expiry and a warning", async () => {
    const [message] = mail.to(ten.email);
    assert.ok(message, "the provider received a message");
    assert.equal(message.from, "AdSense Checker <no-reply@example.test>");
    assert.match(message.subject, /verification code/i);
    const code = mail.latestCode(ten.email);
    assert.ok(message.html.includes(code) && message.text.includes(code));
    assert.match(message.text, /10 minutes/);
    assert.match(message.text, /Never share this code/);
    assert.match(message.html, /AdSense Eligibility Checker/);
    assert.match(message.html, /width=device-width/);
  });

  await check("12 the right code creates exactly that account, as a customer, and signs in", async () => {
    const r = await verify(ten, mail.latestCode(ten.email));
    assert.equal(r.status, 200);
    assert.equal(r.json.redirectTo, "/dashboard");
    const session = pair(cookieNamed(r, "aec_session"));
    assert.ok(session);
    const [row] = users(ten.email);
    assert.equal(row.role, "user", "role/isAdmin in the sign-up body were ignored");
    assert.ok(row.email_verified_at > 0);
    assert.equal(q("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?", row.id)[0].n, 1, "free plan granted");
    assert.equal(pending(ten.email), undefined, "pending row consumed");
    assert.equal((await call("/dashboard", { cookie: session })).status, 200);
    assert.match(cookieNamed(r, "aec_verify"), /Max-Age=0|Expires=Thu, 01 Jan 1970/i, "flow cookie cleared");
  });

  await check("13 a wrong code is rejected and counts down the tries", async () => {
    const flow = await startSignup("thirteen");
    const r = await verify(flow, wrongCode(mail.latestCode(flow.email)));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "CODE_INVALID");
    assert.equal(r.json.attemptsLeft, 4);
    assert.equal(users(flow.email).length, 0);
    // A malformed entry is a typo, not a guess.
    assert.equal((await verify(flow, "12ab")).json.code, "CODE_INVALID");
    assert.equal(pending(flow.email).attempts, 1);
  });

  await check("14 an expired code is rejected", async () => {
    const flow = await startSignup("fourteen");
    q("UPDATE pending_registrations SET code_expires_at = ? WHERE email = ? RETURNING email", Date.now() - 1000, flow.email);
    const r = await verify(flow, mail.latestCode(flow.email));
    assert.equal(r.status, 410);
    assert.equal(r.json.code, "CODE_EXPIRED");
    assert.equal(users(flow.email).length, 0);
  });

  await check("15 a used code cannot be used again", async () => {
    const flow = await startSignup("fifteen");
    const code = mail.latestCode(flow.email);
    assert.equal((await verify(flow, code)).status, 200);
    const again = await verify(flow, code);
    assert.equal(again.status, 404);
    assert.equal(again.json.code, "VERIFICATION_NOT_FOUND");
    assert.equal(users(flow.email).length, 1);
  });

  await check("16 resending replaces the code: the old one stops working", async () => {
    const flow = await startSignup("sixteen");
    const first = mail.latestCode(flow.email);
    skipCooldown(flow.email);
    const r = await resend(flow);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(mail.latestCode(flow.email)), "new code not in the response");
    const second = mail.latestCode(flow.email);
    assert.equal(mail.to(flow.email).length, 2);
    if (second !== first) {
      assert.equal((await verify(flow, first)).json.code, "CODE_INVALID", "old code refused");
    }
    assert.equal((await verify(flow, second)).status, 200, "new code accepted");
  });

  await check("17 five wrong codes destroy the code — even the right one then fails", async () => {
    const flow = await startSignup("seventeen");
    const code = mail.latestCode(flow.email);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push((await verify(flow, wrongCode(code))).json.code);
    assert.deepEqual(results, ["CODE_INVALID", "CODE_INVALID", "CODE_INVALID", "CODE_INVALID", "CODE_LOCKED"]);
    const r = await verify(flow, code);
    assert.equal(r.json.code, "CODE_LOCKED");
    assert.equal(users(flow.email).length, 0);
    assert.equal(pending(flow.email).code_hash, null);
  });

  await check("18 resends are rate-limited: a cooldown, then an hourly cap per address", async () => {
    const flow = await startSignup("eighteen");
    const soon = await resend(flow);
    assert.equal(soon.status, 429);
    assert.equal(soon.json.code, "RATE_LIMITED");
    assert.ok(soon.json.retryAfterSeconds > 0);
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      skipCooldown(flow.email);
      statuses.push((await resend(flow)).status);
    }
    // 1 cooldown refusal + 4 sends use the 5-per-hour budget; the next is capped.
    assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
    // Sign-up itself is capped per address too.
    const again = [];
    for (let i = 0; i < 6; i += 1) {
      again.push(
        (await call("/api/auth/signup", {
          method: "POST",
          ip: newIp(),
          body: { name: "Flood", email: `flood-${stamp}@example.test`, password, confirmPassword: password },
        })).status,
      );
    }
    assert.deepEqual(again, [202, 202, 202, 202, 202, 429]);
  });

  await check("19 signing up again with a registered address changes nothing and reveals nothing", async () => {
    const before = users(aliceEmail)[0];
    const flow = await call("/api/auth/signup", {
      method: "POST",
      ip: newIp(),
      body: { name: "Impostor", email: aliceEmail, password: "Other-Passw0rd!", confirmPassword: "Other-Passw0rd!" },
    });
    const fresh = await startSignup("nineteen-new");
    assert.equal(flow.status, fresh.r.status, "same status as a new address");
    assert.deepEqual(Object.keys(flow.json.verification), Object.keys(fresh.r.json.verification), "same shape");
    // The real owner is told, and gets no code.
    const notice = mail.to(aliceEmail).at(-1);
    assert.match(notice.subject, /already have/i);
    assert.doesNotMatch(notice.text, /\b\d{6}\b/);
    // No code can turn it into a second account or a takeover.
    const dupe = { ip: newIp(), verifyCookie: pair(cookieNamed(flow, "aec_verify")) };
    for (const guess of ["000000", "123456"]) {
      assert.notEqual((await verify(dupe, guess)).status, 200);
    }
    const after = users(aliceEmail);
    assert.equal(after.length, 1);
    assert.equal(after[0].password_hash, before.password_hash);
    assert.equal((await login(aliceEmail, password)).status, 200, "old password still works");
    assert.equal((await login(aliceEmail, "Other-Passw0rd!")).status, 401);
  });

  await check("20 a failed delivery does not verify anything", async () => {
    const email = `bounce-${stamp}@example.test`;
    mail.failFor.add(email);
    const flow = { email, ip: newIp() };
    const r = await call("/api/auth/signup", {
      method: "POST",
      ip: flow.ip,
      body: { name: "Bounce", email, password, confirmPassword: password },
    });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, "EMAIL_DELIVERY_FAILED");
    assert.equal(users(email).length, 0);
    assert.equal(pending(email).code_hash, null, "no code exists to be guessed");
    flow.verifyCookie = pair(cookieNamed(r, "aec_verify"));
    assert.notEqual((await verify(flow, "000000")).status, 200);
    // Once the provider recovers, a resend works normally.
    mail.failFor.delete(email);
    skipCooldown(email);
    assert.equal((await resend(flow)).status, 200);
    assert.equal((await verify(flow, mail.latestCode(email))).status, 200);
  });

  await check("22 concurrent verifications create one account, once", async () => {
    const flow = await startSignup("race");
    const code = mail.latestCode(flow.email);
    const results = await Promise.all(Array.from({ length: 6 }, () => verify(flow, code)));
    assert.equal(results.filter((r) => r.status === 200).length, 1, "exactly one request wins");
    assert.equal(users(flow.email).length, 1);
    const id = users(flow.email)[0].id;
    assert.equal(q("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?", id)[0].n, 1);

    // Two sign-ups for the same new address at once still end in one account.
    const email = `twin-${stamp}@example.test`;
    const body = { name: "Twin", email, password, confirmPassword: password };
    const [a, b] = await Promise.all([
      call("/api/auth/signup", { method: "POST", ip: newIp(), body }),
      call("/api/auth/signup", { method: "POST", ip: newIp(), body }),
    ]);
    assert.deepEqual([a.status, b.status], [202, 202]);
    const codes = mail.to(email).map((m) => m.text.match(/\b(\d{6})\b/)[1]);
    const attempts = [];
    for (const r of [a, b]) {
      for (const c of codes) {
        attempts.push(verify({ ip: newIp(), verifyCookie: pair(cookieNamed(r, "aec_verify")) }, c));
      }
    }
    const done = await Promise.all(attempts);
    assert.equal(done.filter((r) => r.status === 200).length, 1);
    assert.equal(users(email).length, 1);
  });

  await check("21 no code ever appears in the server's output", async () => {
    const codes = mail.messages
      .map((m) => m.text.match(/code is: (\d{6})/)?.[1])
      .filter(Boolean);
    assert.ok(codes.length >= 15, `collected ${codes.length} codes`);
    for (const code of codes) assert.ok(!serverLog.includes(code), `code ${code} found in logs`);
  });

  // A production server with no email provider must refuse, not pretend.
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  const bare = port + 1;
  server = startServer(bare, {});
  await waitFor(`http://127.0.0.1:${bare}/pricing`);
  await check("   with no provider configured, production sign-up refuses instead of pretending", async () => {
    const email = `noprovider-${stamp}@example.test`;
    const r = await call("/api/auth/signup", {
      method: "POST",
      root: `http://127.0.0.1:${bare}`,
      ip: newIp(),
      body: { name: "None", email, password, confirmPassword: password },
    });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "EMAIL_UNCONFIGURED");
    assert.equal(users(email).length, 0);
    assert.equal(pending(email), undefined);
    // Existing accounts are unaffected: login does not need email.
    assert.equal(
      (await call("/api/auth/login", { method: "POST", root: `http://127.0.0.1:${bare}`, ip: newIp(), body: { email: aliceEmail, password } })).status,
      200,
    );
  });

  console.log(`unified login & email verification: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close();
  await rm(dataDir, { recursive: true, force: true });
}
