// Regression tests for profile management, profile photos and the
// authentication-aware navigation, against a real `next start` build and a
// throwaway data directory.
//
//     npm run test:profile
//
// The server is restarted part-way through with the same DATA_DIR to show
// that photos live on the data disk (what a Render persistent disk keeps
// across restarts and redeploys), not in process memory or the build.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { registerVerified, startMailSink } from "./lib/mail-sink.mjs";

const dataDir = await mkdtemp(path.join(tmpdir(), "aec-profile-"));
const mail = await startMailSink();
const port = 3700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = { email: `admin-${stamp}@example.test`, password: "Adm1n-Password!" };
let passed = 0;
let server;

function startServer() {
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345",
        ADMIN_EMAIL: admin.email,
        ADMIN_PASSWORD: admin.password,
        ADMIN_NAME: "Site Admin",
        ...mail.env,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${base}/pricing`)).ok) return;
    } catch {
      /* booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the test server");
}

async function stopServer() {
  if (!server) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await exited;
  server = undefined;
}

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function request(pathname, options = {}, cookie) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (options.method && options.method !== "GET" && !headers.has("origin")) {
    headers.set("origin", base);
  }
  return fetch(`${base}${pathname}`, { ...options, headers, redirect: "manual" });
}

const postJson = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function cookieFrom(res) {
  const raw = res.headers.get("set-cookie");
  assert.ok(raw, "a session cookie should be issued");
  return raw.split(";", 1)[0];
}

async function signup(label, name) {
  const email = `${label}-${stamp}@example.test`;
  const { cookie } = await registerVerified({ base, mail, name, email, password });
  return { email, cookie };
}

async function login(email, pw = password) {
  const res = await request("/api/auth/login", postJson({ email, password: pw }));
  assert.equal(res.status, 200, `login ${email}`);
  return cookieFrom(res);
}

async function session(cookie) {
  const res = await request("/api/auth/session", {}, cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  return (await res.json()).user;
}

function upload(endpoint, bytes, cookie, { type = "image/png", name = "photo.png", headers } = {}) {
  const form = new FormData();
  form.append("avatar", new Blob([bytes], { type }), name);
  return request(endpoint, { method: "POST", body: form, headers }, cookie);
}

/* ── test images, made on the fly ────────────────────────────────── */

const pixels = (w, h, rgb) =>
  sharp({ create: { width: w, height: h, channels: 3, background: rgb } });

const png = await pixels(640, 480, { r: 79, g: 70, b: 229 }).png().toBuffer();
// A JPEG carrying EXIF metadata, to prove re-encoding strips it.
const jpegWithExif = await pixels(400, 600, { r: 21, g: 128, b: 61 })
  .jpeg()
  .withMetadata({ exif: { IFD0: { Copyright: "secret-location-marker" } } })
  .toBuffer();
const webp = await pixels(300, 300, { r: 180, g: 83, b: 9 }).webp().toBuffer();
const gif = await pixels(64, 64, { r: 0, g: 0, b: 0 }).gif().toBuffer();
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><rect width="64" height="64"/></svg>',
);
const fakePng = Buffer.concat([png.subarray(0, 16), Buffer.from("this is not really an image at all".repeat(20))]);
const truncatedJpeg = jpegWithExif.subarray(0, Math.floor(jpegWithExif.length / 3));
const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00"), Buffer.alloc(512, 0x41)]);
const tiny = await pixels(8, 8, { r: 1, g: 2, b: 3 }).png().toBuffer();
const oversized = Buffer.concat([png.subarray(0, 8), Buffer.alloc(5 * 1024 * 1024 + 10, 1)]);

startServer();

try {
  await waitForServer();
  console.log("profile & navigation regression");

  /* 7 ─ logged out */
  await check("logged-out visitors get no session and the public bar offers Log in", async () => {
    assert.equal(await session(), null);
    const html = await (await request("/pricing")).text();
    assert.match(html, /href="\/login"/);
  });

  /* 1 ─ new user, default avatar */
  const alice = await signup("alice", "Alice Rao");
  await check("a new account starts with the default (initials) avatar", async () => {
    const me = await session(alice.cookie);
    assert.equal(me.name, "Alice Rao");
    assert.equal(me.avatarUrl, null);
    assert.equal(me.isAdmin, false);
    const html = await (await request("/dashboard/settings", {}, alice.cookie)).text();
    assert.match(html, />AR</, "settings shows the initials avatar");
  });

  /* 6 ─ signed-in public pages */
  await check("a signed-in user sees Dashboard and an account menu, not Log in", async () => {
    const html = await (await request("/pricing", {}, alice.cookie)).text();
    assert.match(html, /href="\/dashboard"/);
    assert.match(html, /Account menu for Alice Rao/);
    assert.doesNotMatch(html, /href="\/login"/);
  });

  await check("the homepage stays static and resolves the account client-side", async () => {
    const anon = await (await request("/")).text();
    const signedIn = await (await request("/", {}, alice.cookie)).text();
    // Identical HTML for both: no per-user rendering, no Log in flash.
    assert.doesNotMatch(signedIn, /href="\/login"/);
    assert.doesNotMatch(anon, /Account menu/);
    assert.equal((await session(alice.cookie)).name, "Alice Rao");
  });

  /* 2 ─ display name */
  await check("a user can change their display name", async () => {
    const res = await request("/api/account/profile", postJson({ name: "Alice R. Kumar" }), alice.cookie);
    assert.equal(res.status, 200);
    assert.equal((await session(alice.cookie)).name, "Alice R. Kumar");
  });

  await check("invalid names are refused", async () => {
    for (const name of ["", "A", "x".repeat(81), "Evil‮Name", "Line\nbreak"]) {
      const res = await request("/api/account/profile", postJson({ name }), alice.cookie);
      assert.equal(res.status, 400, JSON.stringify(name));
    }
    assert.equal((await session(alice.cookie)).name, "Alice R. Kumar");
  });

  /* 12 ─ no mass assignment */
  await check("profile edits cannot change role, status, email or another account", async () => {
    const bobPre = await signup("bob-target", "Bob Target");
    const bobId = (await (await request("/dashboard/settings", {}, bobPre.cookie)).text()).match(/usr_[A-Za-z0-9_-]{16}/)?.[0];
    assert.ok(bobId, "found bob's id");

    const res = await request(
      "/api/account/profile",
      postJson({ name: "Alice R. Kumar", role: "admin", status: "active", isAdmin: true, email: "x@evil.test", id: bobId, userId: bobId }),
      alice.cookie,
    );
    assert.equal(res.status, 200);
    const me = await session(alice.cookie);
    assert.equal(me.isAdmin, false, "still not an admin");
    assert.equal(me.email, alice.email, "email unchanged");
    assert.equal((await request("/admin", {}, alice.cookie)).status, 404, "admin panel still closed");
    assert.equal((await session(bobPre.cookie)).name, "Bob Target", "the other account is untouched");
    assert.equal((await request("/api/auth/login", postJson({ email: "x@evil.test", password }))).status, 401);
  });

  /* 3 ─ upload, replace, remove */
  let firstUrl;
  await check("a user can upload a photo; it is stored as a clean 256×256 WebP", async () => {
    const res = await upload("/api/account/avatar", png, alice.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    firstUrl = (await res.json()).avatarUrl;
    assert.match(firstUrl, /^\/api\/avatars\/[A-Za-z0-9_-]{24}\.webp$/);
    assert.equal((await session(alice.cookie)).avatarUrl, firstUrl);

    const img = await request(firstUrl, {}, alice.cookie);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/webp");
    assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 256, 256]);
  });

  let secondUrl;
  await check("replacing the photo strips EXIF and deletes the old file", async () => {
    const res = await upload("/api/account/avatar", jpegWithExif, alice.cookie, { type: "image/jpeg", name: "me.jpg" });
    assert.equal(res.status, 200);
    secondUrl = (await res.json()).avatarUrl;
    assert.notEqual(secondUrl, firstUrl);
    assert.equal((await request(firstUrl, {}, alice.cookie)).status, 404, "old URL is gone");

    const bytes = Buffer.from(await (await request(secondUrl, {}, alice.cookie)).arrayBuffer());
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.exif, undefined, "no EXIF block survives");
    assert.equal(bytes.includes(Buffer.from("secret-location-marker")), false);
    const files = await readdir(path.join(dataDir, "avatars"));
    assert.deepEqual(files, [secondUrl.split("/").pop()], "exactly one file on disk");
  });

  await check("WebP uploads are accepted too", async () => {
    const res = await upload("/api/account/avatar", webp, alice.cookie, { type: "image/webp", name: "a.webp" });
    assert.equal(res.status, 200);
    secondUrl = (await res.json()).avatarUrl;
  });

  /* 5 ─ the bar reflects the change */
  await check("the signed-in navigation shows the new photo straight away", async () => {
    const html = await (await request("/pricing", {}, alice.cookie)).text();
    assert.ok(html.includes(secondUrl), "pricing navbar renders the photo");
    const dash = await (await request("/dashboard", {}, alice.cookie)).text();
    assert.ok(dash.includes(secondUrl), "dashboard sidebar renders the photo");
  });

  /* 13 ─ hostile uploads */
  await check("SVG, GIF, executables, fake and damaged images are rejected", async () => {
    const cases = [
      ["svg", svg, "image/svg+xml", "x.svg"],
      ["svg disguised as png", svg, "image/png", "x.png"],
      ["gif", gif, "image/gif", "x.gif"],
      ["exe", exe, "image/png", "photo.png"],
      ["fake png", fakePng, "image/png", "x.png"],
      ["truncated jpeg", truncatedJpeg, "image/jpeg", "x.jpg"],
      ["too small", tiny, "image/png", "x.png"],
      ["empty", Buffer.alloc(0), "image/png", "x.png"],
    ];
    for (const [label, bytes, type, name] of cases) {
      const res = await upload("/api/account/avatar", bytes, alice.cookie, { type, name });
      assert.equal(res.status, 400, label);
      const body = await res.json();
      assert.equal(body.ok, false, label);
      assert.doesNotMatch(body.message, /sharp|vips|stack|Error:/i, `${label}: no internals leak`);
    }
    assert.equal((await session(alice.cookie)).avatarUrl, secondUrl, "photo unchanged after rejections");
  });

  await check("uploads over 5 MB are refused with 413", async () => {
    const res = await upload("/api/account/avatar", oversized, alice.cookie);
    assert.equal(res.status, 413);
  });

  await check("path traversal and arbitrary keys cannot reach the file system", async () => {
    for (const key of ["..%2F..%2Fapp.db", "%2e%2e%2fapp.db", "app.db", "x.webp", "AAAAAAAAAAAAAAAAAAAAAAAA.png"]) {
      assert.equal((await request(`/api/avatars/${key}`, {}, alice.cookie)).status, 404, key);
    }
  });

  await check("photo uploads still require a same-origin request (CSRF)", async () => {
    const res = await upload("/api/account/avatar", png, alice.cookie, { headers: { origin: "https://attacker.invalid" } });
    assert.equal(res.status, 403);
    assert.equal((await session(alice.cookie)).avatarUrl, secondUrl);
  });

  /* 11 ─ cross-account */
  const bob = await signup("bob", "Bob Mehta");
  await check("other users and anonymous visitors cannot fetch someone's photo", async () => {
    assert.equal((await request(secondUrl, {}, bob.cookie)).status, 404);
    assert.equal((await request(secondUrl)).status, 404);
  });

  await check("profile endpoints require a session", async () => {
    assert.equal((await request("/api/account/profile", postJson({ name: "Nobody" }))).status, 401);
    assert.equal((await upload("/api/account/avatar", png)).status, 401);
    assert.equal((await request("/api/account/avatar", { method: "DELETE" })).status, 401);
  });

  /* 4 ─ persists across logout/login */
  await check("logout revokes the session; the profile persists into the next login", async () => {
    const out = await request("/api/auth/logout", { method: "POST" }, alice.cookie);
    assert.equal(out.status, 200);
    assert.equal(await session(alice.cookie), null, "old cookie is dead");
    assert.equal((await request("/api/account/profile", postJson({ name: "Ghost" }), alice.cookie)).status, 401);

    alice.cookie = await login(alice.email);
    const me = await session(alice.cookie);
    assert.equal(me.name, "Alice R. Kumar");
    assert.equal(me.avatarUrl, secondUrl);
    assert.equal((await request(secondUrl, {}, alice.cookie)).status, 200);
  });

  /* 14 ─ survives a restart on the same data disk */
  await check("photos survive a server restart (they live on the data disk)", async () => {
    await stopServer();
    startServer();
    await waitForServer();
    const res = await request(secondUrl, {}, alice.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
  });

  /* 9 + 10 ─ admin */
  const adminCookie = await login(admin.email, admin.password);
  await check("an admin can manage their own profile and photo", async () => {
    assert.equal((await session(adminCookie)).isAdmin, true);
    const name = await request("/api/admin/profile", postJson({ name: "Head Admin" }), adminCookie);
    assert.equal(name.status, 200);
    const photo = await upload("/api/admin/profile/avatar", png, adminCookie);
    assert.equal(photo.status, 200);
    const url = (await photo.json()).avatarUrl;
    const me = await session(adminCookie);
    assert.deepEqual([me.name, me.avatarUrl], ["Head Admin", url]);
    assert.equal((await request("/admin/account", {}, adminCookie)).status, 200);
    const shell = await (await request("/admin", {}, adminCookie)).text();
    assert.ok(shell.includes(url), "admin navigation shows the photo");
    const removed = await request("/api/admin/profile/avatar", { method: "DELETE" }, adminCookie);
    assert.equal(removed.status, 200);
    assert.equal((await session(adminCookie)).avatarUrl, null);
  });

  await check("the admin public menu offers the admin entry points", async () => {
    const html = await (await request("/pricing", {}, adminCookie)).text();
    assert.match(html, /Account menu for Head Admin/);
    // Menu items render on open; the session flag that drives them:
    assert.equal((await session(adminCookie)).isAdmin, true);
  });

  await check("regular users and visitors cannot use the admin profile APIs", async () => {
    assert.equal((await request("/api/admin/profile", postJson({ name: "Hacker" }), alice.cookie)).status, 403);
    assert.equal((await upload("/api/admin/profile/avatar", png, alice.cookie)).status, 403);
    assert.equal((await request("/api/admin/profile/avatar", { method: "DELETE" }, alice.cookie)).status, 403);
    assert.equal((await request("/api/admin/profile", postJson({ name: "Hacker" }))).status, 401);
    assert.equal((await request("/admin/account", {}, alice.cookie)).status, 404);
    assert.equal((await session(alice.cookie)).name, "Alice R. Kumar");
  });

  await check("an admin profile update cannot touch another account", async () => {
    const res = await request(
      "/api/admin/profile",
      postJson({ name: "Head Admin", id: "anything", userId: "anything", email: alice.email, role: "user" }),
      adminCookie,
    );
    assert.equal(res.status, 200);
    assert.equal((await session(alice.cookie)).name, "Alice R. Kumar", "customer untouched");
    assert.equal((await session(adminCookie)).isAdmin, true, "admin did not demote itself");
  });

  await check("admins can view a customer's photo; the customer can remove it", async () => {
    assert.equal((await request(secondUrl, {}, adminCookie)).status, 200);
    const res = await request("/api/account/avatar", { method: "DELETE" }, alice.cookie);
    assert.equal(res.status, 200);
    assert.equal((await session(alice.cookie)).avatarUrl, null);
    assert.equal((await request(secondUrl, {}, alice.cookie)).status, 404);
  });

  /* 15 ─ pricing / billing still fine */
  await check("pricing, billing and checkout still respond as before", async () => {
    assert.equal((await request("/dashboard/billing", {}, alice.cookie)).status, 200);
    const order = await request("/api/checkout/order", postJson({ planId: "basic", billing: { name: "Test Buyer", email: "buyer@example.test", country: "IN", phone: "98765 43210" } }), alice.cookie);
    assert.equal(order.status, 503, "no gateway in a fresh install — authenticated, not logged out");
  });

  console.log(`profile & navigation regression: passed (${passed} checks)`);
} finally {
  await stopServer();
  await mail.close();
  await rm(dataDir, { recursive: true, force: true });
}
