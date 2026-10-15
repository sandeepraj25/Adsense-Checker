// Google SMTP email verification, against a real `next start` build, a
// throwaway database and a local SMTP server (scripts/lib/smtp-sink.mjs)
// that the app's real Nodemailer transport connects to.
//
// Run after `npm run build`:  node scripts/smtp-test.mjs
//
// This proves the SMTP code path end to end. It does not prove delivery
// through smtp.gmail.com itself — that needs a real Google account and
// App Password (see README → "Email (Google SMTP)").

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { startSmtpSink } from "./lib/smtp-sink.mjs";
import { isolatedServerEnv } from "./lib/server-env.mjs";
import { REMOTE_SMTP_HOST } from "./fixtures/remote-smtp-hook.mjs";

const REMOTE_SMTP_HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "remote-smtp-hook.mjs");

const SECRET = "test-auth-secret-that-is-long-enough-to-be-safe-12345";
const SMTP_USER = "sender@example.test";
const APP_PASSWORD = "abcdefghijklmnop";
const dataDir = await mkdtemp(path.join(tmpdir(), "aec-smtp-"));
const port = 4500 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = { email: `admin-${stamp}@example.test`, password: "Adm1n-Password!" };
const sink = await startSmtpSink({ user: SMTP_USER, pass: APP_PASSWORD });
let passed = 0;
let serverLog = "";

const smtpEnv = {
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(sink.port),
  SMTP_SECURE: "false",
  SMTP_USER,
  // As Google displays it, in groups of four: the spaces must not matter.
  SMTP_APP_PASSWORD: "abcd efgh ijkl mnop",
  EMAIL_FROM: `AdSense Checker <${SMTP_USER}>`,
  APP_URL: "https://app.example.test",
};

function startServer(p, extraEnv) {
  const env = { ...process.env, NODE_ENV: "production", DATA_DIR: dataDir, AUTH_SECRET: SECRET, ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: admin.password, CHECKOUT_ALERTS_BACKGROUND: "off", ...extraEnv };
  // The SMTP variables alone must select the SMTP provider.
  for (const name of ["EMAIL_PROVIDER", "RESEND_API_KEY", "RESEND_API_URL", "NEXT_PUBLIC_APP_URL", "PAYMENTS_MODE"]) if (!(name in extraEnv)) delete env[name];
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(p)], { cwd: process.cwd(), env: isolatedServerEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));
  return child;
}

/** Stops a server and waits until it has really exited and freed its port. */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
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
  try {
    await fn();
  } catch (error) {
    console.log(`  ✗ ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

let ipSeq = 0;
const newIp = () => `203.0.113.${(ipSeq += 1)}`;

async function call(pathname, { method = "GET", body, cookie, ip = "198.51.100.1", root = base, headers: extra = {} } = {}) {
  const headers = new Headers({ "x-forwarded-for": ip, ...extra });
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET" && !headers.has("origin")) headers.set("origin", root);
  if (body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${root}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
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

function q(sql, ...args) {
  const handle = new DatabaseSync(path.join(dataDir, "app.db"));
  handle.exec("PRAGMA busy_timeout = 5000");
  try {
    return handle.prepare(sql).all(...args);
  } finally {
    handle.close();
  }
}
const users = (email) => q("SELECT * FROM users WHERE email = ?", email);
const pending = (email) => q("SELECT * FROM pending_registrations WHERE email = ?", email)[0];
const skipCooldown = (email) => q("UPDATE pending_registrations SET last_sent_at = last_sent_at - 61000 WHERE email = ? RETURNING email", email);

async function signup(label, extra = {}) {
  const email = `${label}-${stamp}@example.test`;
  const ip = newIp();
  const r = await call("/api/auth/signup", { method: "POST", ip, body: { name: `Test ${label}`, email, password, confirmPassword: password, ...extra.body }, headers: extra.headers });
  return { email, ip, r, verifyCookie: pair(cookieNamed(r, "aec_verify")) };
}
const verify = (flow, code) => call("/api/auth/verify-email", { method: "POST", ip: flow.ip, cookie: flow.verifyCookie, body: { code } });
const resend = (flow) => call("/api/auth/resend-verification", { method: "POST", ip: flow.ip, cookie: flow.verifyCookie });
const login = (email, pw) => call("/api/auth/login", { method: "POST", ip: newIp(), body: { email, password: pw } });
const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

let server = startServer(port, smtpEnv);

try {
  await waitFor(`${base}/pricing`);
  console.log("google smtp email verification");

  let alice;
  await check("1  sign-up sends the code through SMTP, signed in with the App Password", async () => {
    alice = await signup("alice");
    assert.equal(alice.r.status, 202, alice.r.text);
    assert.equal(alice.r.json.ok, true);
    assert.ok(alice.verifyCookie, "verification is bound to this browser");
    const [mail] = sink.to(alice.email);
    assert.ok(mail, "the SMTP server received the message");
    assert.deepEqual(sink.logins.at(-1), { user: SMTP_USER, pass: APP_PASSWORD }, "logged in as SMTP_USER with the App Password, spaces removed");
    assert.equal(mail.from, SMTP_USER, "envelope sender is EMAIL_FROM's address");
    assert.match(mail.fromHeader, /AdSense Checker/);
    assert.match(mail.subject, /^\d{6} is your AdSense Eligibility Checker verification code$/);
    assert.match(mail.contentType, /multipart\/alternative/, "HTML with a plain-text fallback");
    const code = sink.codeFor(alice.email);
    assert.ok(mail.text.includes(code) && mail.html.includes(code), "the code is in both parts");
    assert.match(mail.text, /expires in 10 minutes/);
    assert.match(mail.html, /ignore this email/);
    assert.ok(!users(alice.email).length, "no account exists before the code is entered");
  });

  await check("2  only a hash of the code is stored, never the code itself", async () => {
    const code = sink.codeFor(alice.email);
    const row = pending(alice.email);
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes(code), "the code is not in the database row");
    assert.ok(!serverLog.includes(code), "the code is not in the server log");
    assert.ok(!serverLog.includes(APP_PASSWORD) && !serverLog.includes("abcd efgh"), "the App Password is not in the server log");
  });

  await check("3  a wrong code is refused and counts against the attempt limit", async () => {
    const r = await verify(alice, wrongCode(sink.codeFor(alice.email)));
    assert.equal(r.json.code, "CODE_INVALID");
    assert.equal(r.json.attemptsLeft, 4);
    assert.ok(!users(alice.email).length);
  });

  await check("4  the right code verifies the right account and signs it in", async () => {
    const r = await verify(alice, sink.codeFor(alice.email));
    assert.equal(r.status, 200, r.text);
    assert.ok(cookieNamed(r, "aec_session"), "session only after verification");
    const [user] = users(alice.email);
    assert.ok(user && user.email_verified_at > 0, "email_verified_at stamped on the server");
    assert.equal(user.role, "user", "sign-up never creates an administrator");
    assert.ok(!pending(alice.email), "pending sign-up consumed");
  });

  await check("5  the same code cannot be used twice", async () => {
    const r = await verify(alice, sink.codeFor(alice.email));
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "VERIFICATION_NOT_FOUND");
    assert.equal(users(alice.email).length, 1);
  });

  await check("6  the verified customer and the administrator log in as before", async () => {
    const a = await login(alice.email, password);
    assert.equal(a.status, 200);
    assert.equal(a.json.redirectTo, "/dashboard");
    const adm = await login(admin.email, admin.password);
    assert.equal(adm.status, 200);
    assert.equal(adm.json.redirectTo, "/admin");
  });

  await check("7  an expired code is refused", async () => {
    const flow = await signup("expired");
    q("UPDATE pending_registrations SET code_expires_at = ? WHERE email = ? RETURNING email", Date.now() - 1000, flow.email);
    const r = await verify(flow, sink.codeFor(flow.email));
    assert.equal(r.json.code, "CODE_EXPIRED");
    assert.ok(!users(flow.email).length);
  });

  await check("8  resend waits out the server-side cooldown, then replaces the old code", async () => {
    const flow = await signup("resend");
    const first = sink.codeFor(flow.email);
    const early = await resend(flow);
    assert.equal(early.json.code, "RATE_LIMITED");
    assert.equal(sink.to(flow.email).length, 1, "no second email during the cooldown");
    skipCooldown(flow.email);
    const again = await resend(flow);
    assert.equal(again.status, 200, again.text);
    const second = sink.codeFor(flow.email);
    assert.equal(sink.to(flow.email).length, 2);
    if (second !== first) {
      assert.equal((await verify(flow, first)).json.ok, false, "the old code stopped working");
    }
    assert.equal((await verify(flow, second)).status, 200);
  });

  await check("9  five wrong codes lock the code; the right one no longer works", async () => {
    const flow = await signup("locked");
    const code = sink.codeFor(flow.email);
    for (let i = 0; i < 5; i += 1) await verify(flow, wrongCode(code));
    const r = await verify(flow, code);
    assert.equal(r.json.code, "CODE_LOCKED");
    assert.ok(!users(flow.email).length);
  });

  await check("10 a refused App Password (535) fails sign-up clearly and verifies nothing", async () => {
    sink.state.badPassword = true;
    try {
      const flow = await signup("authfail");
      assert.equal(flow.r.status, 502, flow.r.text);
      assert.equal(flow.r.json.code, "EMAIL_DELIVERY_FAILED");
      assert.doesNotMatch(flow.r.text, /535|App Password|SMTP/i, "operator details are not shown to the visitor");
      assert.equal(pending(flow.email).code_hash, null, "no usable code exists");
      assert.equal((await verify(flow, "123456")).json.ok, false);
      assert.ok(!users(flow.email).length, "no account");
      assert.match(serverLog, /SMTP sign-in was refused \(EAUTH 535 5\.7\.8\)/, "the operator log says why");
    } finally {
      sink.state.badPassword = false;
    }
  });

  await check("11 a rejected recipient, a temporary failure or the Gmail quota never count as sent", async () => {
    const rejected = `nobody-${stamp}@example.test`;
    sink.state.rejectRcpt.add(rejected);
    const r1 = await call("/api/auth/signup", { method: "POST", ip: newIp(), body: { name: "Nobody", email: rejected, password, confirmPassword: password } });
    assert.equal(r1.json.code, "EMAIL_DELIVERY_FAILED");
    assert.equal(pending(rejected).code_hash, null);

    sink.state.tempFail = true;
    const f2 = await signup("tempfail");
    sink.state.tempFail = false;
    assert.equal(f2.r.json.code, "EMAIL_DELIVERY_FAILED");
    assert.equal(pending(f2.email).code_hash, null);

    sink.state.quota = true;
    const f3 = await signup("quota");
    sink.state.quota = false;
    assert.equal(f3.r.json.code, "EMAIL_DELIVERY_FAILED");
    assert.match(serverLog, /daily sending limit/);

    // Once the provider works again, the same address can simply retry.
    const retry = await signup("tempfail");
    assert.equal(retry.r.status, 202);
    assert.equal((await verify(retry, sink.codeFor(retry.email))).status, 200);
    assert.equal(users(retry.email).length, 1, "one account, no duplicates");
  });

  await check("12 an address that already has an account gets a notice, and the response looks the same", async () => {
    const before = sink.to(alice.email).length;
    const again = await call("/api/auth/signup", {
      method: "POST",
      ip: newIp(),
      body: { name: "Someone", email: alice.email, password, confirmPassword: password },
      // An attacker controls every header of their own request.
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", origin: "http://evil.example" },
    });
    assert.equal(again.status, 202);
    assert.deepEqual(Object.keys(again.json).sort(), Object.keys(alice.r.json).sort(), "same response shape as a new sign-up");
    const notice = sink.to(alice.email).at(-1);
    assert.equal(sink.to(alice.email).length, before + 1);
    assert.match(notice.subject, /already have/);
    assert.ok(notice.text.includes("https://app.example.test/login"), "the link uses the configured APP_URL");
    assert.ok(!notice.raw.includes("evil.example"), "not the Host header");
    assert.equal(users(alice.email).length, 1);
  });

  await check("13 payment alerts go through the same SMTP mailer", async () => {
    q("INSERT OR REPLACE INTO app_settings (key, value, updated_at, updated_by) VALUES ('alerts.email', ?, ?, 'test')", `ops-${stamp}@example.test`, Date.now());
    const adm = await login(admin.email, admin.password);
    const cookie = pair(cookieNamed(adm, "aec_session"));
    const page = await call("/admin/settings/notifications", { cookie });
    assert.match(page.text.replace(/<!-- -->/g, ""), /Delivered through SMTP \(127\.0\.0\.1:\d+\)/);
    const r = await call("/api/admin/notifications/test", { method: "POST", cookie });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.delivered, true);
    assert.equal(sink.to(`ops-${stamp}@example.test`).length, 1);
  });

  // ── configuration problems: sign-up pauses instead of pretending ──
  await stop(server);

  const configCases = [
    ["missing App Password", { ...smtpEnv, SMTP_APP_PASSWORD: "" }, /SMTP_APP_PASSWORD is not set/],
    ["normal password on smtp.gmail.com", { ...smtpEnv, SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_APP_PASSWORD: "MyNormalPassword1!" }, /doesn't look like a Google App Password/],
    ["port 465 without TLS", { ...smtpEnv, SMTP_PORT: "465", SMTP_SECURE: "false" }, /465, which needs SMTP_SECURE=true/],
  ];
  for (const [label, env, problem] of configCases) {
    await check(`14 ${label}: sign-up is paused with a clear operator message`, async () => {
      const p2 = port + 1;
      const before = sink.messages.length;
      serverLog = "";
      const child = startServer(p2, env);
      try {
        await waitFor(`http://127.0.0.1:${p2}/pricing`);
        const email = `cfg-${Math.random().toString(36).slice(2)}@example.test`;
        const r = await call("/api/auth/signup", { method: "POST", root: `http://127.0.0.1:${p2}`, ip: newIp(), body: { name: "Cfg", email, password, confirmPassword: password } });
        assert.equal(r.json.code, "EMAIL_UNCONFIGURED");
        assert.ok(!pending(email), "nothing pending");
        assert.equal(sink.messages.length, before, "nothing sent");
        assert.match(serverLog, problem);
        assert.ok(!serverLog.includes("MyNormalPassword1!"), "the password is never printed");
      } finally {
        await stop(child);
      }
    });
  }

  await check("15 a non-local server that doesn't offer STARTTLS is never sent the password", async () => {
    // A host name the app treats as remote (it is not localhost, 127.0.0.1
    // or ::1) that the test server resolves to the local sink — portable,
    // unlike a spare loopback address such as 127.0.0.2, which macOS lacks.
    const plain = await startSmtpSink({ user: SMTP_USER, pass: APP_PASSWORD });
    const p2 = port + 2;
    serverLog = "";
    const child = startServer(p2, {
      ...smtpEnv,
      SMTP_HOST: REMOTE_SMTP_HOST,
      SMTP_PORT: String(plain.port),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${pathToFileURL(REMOTE_SMTP_HOOK).href}`].filter(Boolean).join(" "),
    });
    try {
      await waitFor(`http://127.0.0.1:${p2}/pricing`);
      const email = `plain-${stamp}@example.test`;
      const r = await call("/api/auth/signup", { method: "POST", root: `http://127.0.0.1:${p2}`, ip: newIp(), body: { name: "Plain", email, password, confirmPassword: password } });
      assert.equal(r.json.code, "EMAIL_DELIVERY_FAILED");
      assert.ok(plain.greetings.length > 0, "the app reached the sink by its host name (not a DNS failure)");
      assert.equal(plain.logins.length, 0, "no AUTH was attempted over the plain connection");
      assert.equal(plain.messages.length, 0);
      assert.equal(pending(email).code_hash, null);
    } finally {
      await stop(child);
      await plain.close();
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  console.log(`google smtp email verification: passed (${passed} checks)`);
} finally {
  server.kill();
  await sink.close();
  await rm(dataDir, { recursive: true, force: true });
}
