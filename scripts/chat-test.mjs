// Live chat: ownership, live delivery, staff inbox, support team.
//
//     npm run build && node scripts/chat-test.mjs
//
// Runs the production build on a throwaway database. Live delivery is
// checked by reading the Server-Sent-Events streams themselves.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { registerVerified, startMailSink } from "./lib/mail-sink.mjs";

const dataDir = await mkdtemp(path.join(tmpdir(), "aec-chat-"));
const port = 4800 + Math.floor(Math.random() * 150);
const base = `http://127.0.0.1:${port}`;
const stamp = Date.now();
const password = "Str0ng-Password!";
const admin = { email: `chat-admin-${stamp}@example.test`, password: "Adm1n-Password!" };
const mail = await startMailSink();
let passed = 0;
let serverLog = "";

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    DATA_DIR: dataDir,
    AUTH_SECRET: "test-auth-secret-that-is-long-enough-to-be-safe-12345",
    ADMIN_EMAIL: admin.email,
    ADMIN_PASSWORD: admin.password,
    ...mail.env,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

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

/** A browser: its own cookie jar and client address. */
let ipSeq = 0;
function browser() {
  const jar = new Map();
  const ip = `203.0.113.${(ipSeq += 1)}`;
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  async function call(pathname, { method = "GET", body } = {}) {
    const headers = new Headers({ "x-forwarded-for": ip });
    if (jar.size) headers.set("cookie", cookie());
    if (method !== "GET") headers.set("origin", base);
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [k, ...v] = pair.split("=");
      if (/Max-Age=0/i.test(raw) || v.join("=") === "") jar.delete(k);
      else jar.set(k, v.join("="));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text: text.replace(/<!-- -->/g, ""), raw: res.headers.getSetCookie() };
  }
  /** Opens an SSE stream and collects its events. */
  async function stream(pathname) {
    const controller = new AbortController();
    const headers = new Headers({ "x-forwarded-for": ip, accept: "text/event-stream" });
    if (jar.size) headers.set("cookie", cookie());
    const res = await fetch(`${base}${pathname}`, { headers, signal: controller.signal });
    const events = [];
    let buffer = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (name) events.push({ name, data: data ? JSON.parse(data) : null, raw: block, at: Date.now() });
          }
        }
      } catch { /* aborted */ }
    })();
    const waitFor = async (pred, ms = 4000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no matching event within ${ms}ms; got ${JSON.stringify(events.map((e) => e.data))}`);
    };
    await waitFor((e) => e.name === "ready");
    return { status: res.status, headers: res.headers, events, waitFor, close: () => controller.abort() };
  }
  return { call, stream, jar, ip };
}

const db = () => { const h = new DatabaseSync(path.join(dataDir, "app.db")); h.exec("PRAGMA busy_timeout = 5000"); return h; };
const q = (sql, ...args) => { const h = db(); try { return h.prepare(sql).all(...args); } finally { h.close(); } };
const send = (b, body, clientId) => b.call("/api/chat/messages", { method: "POST", body: { body, clientId } });
const cid = () => `c${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

try {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/pricing`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log("live chat");

  const staff = browser();
  assert.equal((await staff.call("/api/auth/login", { method: "POST", body: { email: admin.email, password: admin.password } })).status, 200);

  await check("1  the widget is on public and customer pages, not on admin or checkout", async () => {
    const anon = browser();
    for (const page of ["/", "/pricing", "/team", "/login"]) {
      assert.match((await anon.call(page)).text, /aria-label="Open support chat"/, `${page} has the chat button`);
    }
    assert.doesNotMatch((await staff.call("/admin")).text, /aria-label="Open support chat"/, "not in the admin panel");
  });

  await check("2  a visitor sees the team and that support is offline — and no private data", async () => {
    const anon = browser();
    const r = await anon.call("/api/chat");
    assert.equal(r.status, 200);
    assert.equal(r.json.support.online, false);
    assert.deepEqual(r.json.support.team.map((m) => `${m.name}:${m.role}`), ["Sandeep:Admin", "Gungun:Member"]);
    assert.equal(r.json.thread.exists, false);
    assert.doesNotMatch(r.text, /agt_|@|user_id|userId/, "no ids or emails leak to the public");
    assert.equal(q("SELECT COUNT(*) n FROM chat_conversations")[0].n, 0, "browsing creates nothing");
  });

  const guest = browser();
  let guestConvId;
  await check("3  a guest's first message creates their conversation and an httpOnly cookie", async () => {
    const r = await send(guest, "Hi, my site was rejected for low-value content. What should I check?", cid());
    assert.equal(r.status, 201, r.text);
    const cookie = r.raw.find((c) => c.startsWith("aec_chat="));
    assert.ok(cookie, "chat cookie set");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const [conv] = q("SELECT * FROM chat_conversations");
    guestConvId = conv.id;
    assert.match(conv.id, /^conv_[A-Za-z0-9_-]{16}$/, "random, non-sequential id");
    assert.equal(conv.user_id, null);
    const token = guest.jar.get("aec_chat");
    assert.notEqual(conv.guest_token_hash, token, "only a hash of the token is stored");
    assert.ok(!token.includes(conv.id), "the cookie is not the conversation id");
    const back = await guest.call("/api/chat");
    assert.equal(back.json.thread.messages.length, 1);
    assert.equal(back.json.thread.messages[0].from, "customer");
  });

  await check("4  another visitor — or a forged cookie — cannot read that conversation", async () => {
    const other = browser();
    assert.equal((await other.call("/api/chat")).json.thread.exists, false);
    other.jar.set("aec_chat", "A".repeat(43));
    assert.equal((await other.call("/api/chat")).json.thread.exists, false);
    other.jar.set("aec_chat", guestConvId);
    assert.equal((await other.call("/api/chat")).json.thread.exists, false);
    // Nothing on the customer side accepts a conversation id at all.
    const r = await other.call(`/api/chat?conversationId=${guestConvId}&id=${guestConvId}`);
    assert.equal(r.json.thread.exists, false);
  });

  await check("5  a double-sent message is stored once; bad input is refused", async () => {
    const id = cid();
    const a = await send(guest, "Same message twice", id);
    const b = await send(guest, "Same message twice", id);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.equal(q("SELECT COUNT(*) n FROM chat_messages WHERE body = 'Same message twice'")[0].n, 1);
    assert.equal((await send(guest, "   ", cid())).status, 400);
    assert.equal((await send(guest, "x".repeat(2001), cid())).status, 400);
    assert.equal((await guest.call("/api/chat/messages", { method: "POST", body: { body: 42 } })).status, 400);
  });

  await check("6  customers and visitors cannot use any staff endpoint", async () => {
    const anon = browser();
    assert.equal((await anon.call("/api/admin/chats")).status, 401);
    assert.equal((await guest.call(`/api/admin/chats/${guestConvId}`)).status, 401);
    assert.equal((await guest.call(`/api/admin/chats/${guestConvId}/messages`, { method: "POST", body: { body: "hi" } })).status, 401);
    assert.equal((await guest.call("/api/admin/support-team", { method: "POST", body: { displayName: "X", role: "admin" } })).status, 401);
    assert.equal((await guest.call("/api/admin/chats/stream")).status, 401);
  });

  let sandeep;
  await check("7  an admin with no linked support profile can read but not reply", async () => {
    const list = await staff.call("/api/admin/chats");
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);
    assert.equal(list.json.items[0].unread, 2);
    assert.equal(list.json.me, null);
    assert.match(list.json.replyBlocker, /isn't linked/);
    const r = await staff.call(`/api/admin/chats/${guestConvId}/messages`, { method: "POST", body: { body: "hi", clientId: cid() } });
    assert.equal(r.status, 403);
    sandeep = (await staff.call("/api/admin/support-team")).json.agents.find((a) => a.displayName === "Sandeep");
    const adminId = q("SELECT id FROM users WHERE email = ?", admin.email)[0].id;
    const link = await staff.call(`/api/admin/support-team/${sandeep.id}`, { method: "PATCH", body: { userId: adminId } });
    assert.equal(link.status, 200, link.text);
  });

  await check("8  support comes online while an agent has the inbox open, and goes away on request", async () => {
    const inbox = await staff.stream("/api/admin/chats/stream");
    assert.match(inbox.headers.get("content-type"), /text\/event-stream/);
    assert.match(inbox.headers.get("cache-control"), /no-transform/);
    const status = (await browser().call("/api/chat")).json.support;
    assert.equal(status.online, true);
    assert.deepEqual(status.team.filter((m) => m.online).map((m) => m.name), ["Sandeep"]);
    await staff.call(`/api/admin/support-team/${sandeep.id}`, { method: "PATCH", body: { availability: "away" } });
    assert.equal((await browser().call("/api/chat")).json.support.online, false);
    await staff.call(`/api/admin/support-team/${sandeep.id}`, { method: "PATCH", body: { availability: "available" } });
    inbox.close();
  });

  await check("9  a reply reaches the guest's open stream live, as Sandeep · Admin", async () => {
    const live = await guest.stream("/api/chat/stream");
    const sent = Date.now();
    const r = await staff.call(`/api/admin/chats/${guestConvId}/messages`, { method: "POST", body: { body: "Hi! Start with your thinnest pages.", clientId: cid() } });
    assert.equal(r.status, 201, r.text);
    const event = await live.waitFor((e) => e.name === "chat" && e.data.type === "message" && e.data.from === "agent");
    assert.ok(event.at - sent < 2000, `delivered in ${event.at - sent}ms`);
    assert.equal(event.data.conversationId, guestConvId);
    assert.doesNotMatch(event.raw, /thinnest/, "the stream carries ids, never message text");
    const thread = (await guest.call("/api/chat")).json.thread;
    const reply = thread.messages.at(-1);
    assert.deepEqual([reply.from, reply.agent.name, reply.agent.role], ["agent", "Sandeep", "Admin"]);
    assert.equal(thread.unread, 1, "unread until the widget is opened");
    live.close();
  });

  await check("10 another visitor's stream hears nothing about this conversation", async () => {
    const other = browser();
    await send(other, "Unrelated question", cid());
    const theirs = await other.stream("/api/chat/stream");
    await staff.call(`/api/admin/chats/${guestConvId}/messages`, { method: "POST", body: { body: "Private to the first guest", clientId: cid() } });
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!theirs.events.some((e) => e.data?.conversationId === guestConvId), "no event for someone else's chat");
    theirs.close();
  });

  await check("11 read state: opening marks replies read on both sides", async () => {
    const opened = await guest.call("/api/chat?read=1");
    assert.equal(opened.json.thread.unread, 0);
    const detail = await staff.call(`/api/admin/chats/${guestConvId}`);
    const lastAgent = detail.json.detail.messages.filter((m) => m.from === "agent").at(-1);
    assert.equal(lastAgent.seen, true, "agent sees 'Seen by customer'");
    assert.equal(detail.json.detail.item.unread, 0, "opening the conversation clears the staff unread count");
    const inbox = await staff.stream("/api/admin/chats/stream");
    await send(guest, "Thanks! Which pages count as thin?", cid());
    await inbox.waitFor((e) => e.data?.type === "message" && e.data.from === "customer");
    assert.equal((await staff.call("/api/admin/chats")).json.items.find((i) => i.id === guestConvId).unread, 1);
    inbox.close();
  });

  await check("12 resolving and reopening; the first replier owns the chat", async () => {
    let list = (await staff.call("/api/admin/chats?filter=mine")).json;
    assert.deepEqual(list.items.map((i) => i.id), [guestConvId], "auto-assigned to Sandeep on first reply");
    const res = await staff.call(`/api/admin/chats/${guestConvId}`, { method: "PATCH", body: { status: "resolved" } });
    assert.equal(res.json.detail.item.status, "resolved");
    assert.equal((await guest.call("/api/chat")).json.thread.status, "resolved");
    assert.equal((await staff.call("/api/admin/chats?filter=resolved")).json.items.length, 1);
    await send(guest, "One more thing…", cid());
    assert.equal((await guest.call("/api/chat")).json.thread.status, "open", "a new customer message reopens it");
    const gungun = (await staff.call("/api/admin/support-team")).json.agents.find((a) => a.displayName === "Gungun");
    const assigned = await staff.call(`/api/admin/chats/${guestConvId}`, { method: "PATCH", body: { assignedAgentId: gungun.id } });
    assert.equal(assigned.json.detail.item.assignedAgent.name, "Gungun");
    assert.equal((await staff.call(`/api/admin/chats/${guestConvId}`, { method: "PATCH", body: { assignedAgentId: "agt_nobody" } })).status, 400);
    list = (await staff.call("/api/admin/chats?filter=unread")).json;
    assert.ok(list.items.every((i) => i.unread > 0));
  });

  await check("13 a guest can leave an email; staff see it", async () => {
    assert.equal((await guest.call("/api/chat/contact", { method: "POST", body: { name: "Riya", email: "not-an-email" } })).status, 400);
    assert.equal((await guest.call("/api/chat/contact", { method: "POST", body: { name: "Riya", email: "riya@example.test" } })).status, 200);
    const item = (await staff.call("/api/admin/chats")).json.items.find((i) => i.id === guestConvId);
    assert.deepEqual([item.customerName, item.customerEmail, item.isGuest], ["Riya (guest)", "riya@example.test", true]);
  });

  const userEmail = `chat-user-${stamp}@example.test`;
  await check("14 a signed-in user's chat belongs to their account, on any device", async () => {
    const reg = await registerVerified({ base, mail, name: "Arjun Mehta", email: userEmail, password });
    const laptop = browser();
    laptop.jar.set("aec_session", reg.cookie.split("=").slice(1).join("="));
    assert.equal((await send(laptop, "Can I upgrade mid-month?", cid())).status, 201);
    const [conv] = q("SELECT c.* FROM chat_conversations c JOIN users u ON u.id = c.user_id WHERE u.email = ?", userEmail);
    assert.ok(conv && conv.guest_token_hash === null, "linked to the account, not a guest cookie");
    const phone = browser();
    assert.equal((await phone.call("/api/auth/login", { method: "POST", body: { email: userEmail, password } })).status, 200);
    const thread = (await phone.call("/api/chat")).json.thread;
    assert.deepEqual(thread.messages.map((m) => m.body), ["Can I upgrade mid-month?"]);
    const item = (await staff.call("/api/admin/chats")).json.items.find((i) => i.id === conv.id);
    assert.deepEqual([item.customerName, item.customerEmail, item.isGuest], ["Arjun Mehta", userEmail, false]);
    const detail = (await staff.call(`/api/admin/chats/${conv.id}`)).json.detail;
    assert.equal(detail.account.email, userEmail);
    assert.equal(detail.account.plan, "Free");
  });

  await check("15 chatting as a guest, then signing in, merges into one conversation", async () => {
    const b = browser();
    await send(b, "Asked before logging in", cid());
    const guestToken = b.jar.get("aec_chat");
    assert.equal((await b.call("/api/auth/login", { method: "POST", body: { email: userEmail, password } })).status, 200);
    const thread = (await b.call("/api/chat")).json.thread;
    assert.deepEqual(thread.messages.map((m) => m.body), ["Can I upgrade mid-month?", "Asked before logging in"]);
    assert.equal(b.jar.has("aec_chat"), false, "guest cookie cleared");
    assert.equal(q("SELECT COUNT(*) n FROM chat_conversations c JOIN users u ON u.id = c.user_id WHERE u.email = ?", userEmail)[0].n, 1);
    const replay = browser();
    replay.jar.set("aec_chat", guestToken);
    assert.equal((await replay.call("/api/chat")).json.thread.exists, false, "the old guest token now opens nothing");
    // Signing out does not expose the account's chat to the next guest.
    await b.call("/api/auth/logout", { method: "POST" });
    assert.equal((await b.call("/api/chat")).json.thread.exists, false);
  });

  await check("16 message text is stored and shown as text, never as markup", async () => {
    const b = browser();
    await send(b, `<img src=x onerror="alert(1)"><script>alert(2)</script>`, cid());
    const page = await staff.call("/admin/chats");
    assert.doesNotMatch(page.text, /<script>alert\(2\)<\/script>/);
    assert.doesNotMatch(page.text, /<img src=x onerror/);
    const thread = (await b.call("/api/chat")).json.thread;
    assert.equal(thread.messages[0].body, `<img src=x onerror="alert(1)"><script>alert(2)</script>`);
  });

  await check("17 support team: add, rename, change role, link only admins, rota, deactivate", async () => {
    const add = await staff.call("/api/admin/support-team", { method: "POST", body: { displayName: "Priya", role: "member" } });
    assert.equal(add.status, 201, add.text);
    const id = add.json.agent.id;
    assert.equal((await staff.call(`/api/admin/support-team/${id}`, { method: "PATCH", body: { displayName: "Priya S", role: "admin" } })).json.agent.displayName, "Priya S");
    const userId = q("SELECT id FROM users WHERE email = ?", userEmail)[0].id;
    const notAdmin = await staff.call(`/api/admin/support-team/${id}`, { method: "PATCH", body: { userId } });
    assert.equal(notAdmin.status, 400, "a customer account can't be linked");
    const adminId = q("SELECT id FROM users WHERE email = ?", admin.email)[0].id;
    const taken = await staff.call(`/api/admin/support-team/${id}`, { method: "PATCH", body: { userId: adminId } });
    assert.equal(taken.status, 400, "one profile per login");
    assert.equal((await staff.call("/api/admin/support-team", { method: "POST", body: { displayName: "" , role: "member" } })).status, 400);
    assert.equal((await staff.call("/api/admin/support-team", { method: "POST", body: { displayName: "Bad", role: "owner" } })).status, 400);
    const off = await staff.call(`/api/admin/support-team/${id}`, { method: "PATCH", body: { chatEnabled: false } });
    assert.equal(off.json.agent.chatEnabled, false);
    assert.ok(!(await browser().call("/api/chat")).json.support.team.some((m) => m.name === "Priya S"), "off the rota → not shown to customers");
    const gungun = (await staff.call("/api/admin/support-team")).json.agents.find((a) => a.displayName === "Gungun");
    await staff.call(`/api/admin/support-team/${gungun.id}`, { method: "PATCH", body: { active: false } });
    const item = (await staff.call(`/api/admin/chats/${guestConvId}`)).json.detail.item;
    assert.equal(item.assignedAgent, null, "deactivating releases their open chats");
    const log = await staff.call("/admin/logs?target=support");
    assert.match(log.text, /support\.member_added/);
    assert.match(log.text, /deactivated/);
  });

  await check("18 deleting: refused for anyone who replied, allowed otherwise", async () => {
    const del = await staff.call(`/api/admin/support-team/${sandeep.id}`, { method: "DELETE" });
    assert.equal(del.status, 409);
    assert.match(del.json.message, /Deactivate them instead/);
    const fresh = await staff.call("/api/admin/support-team", { method: "POST", body: { displayName: "Temp", role: "member" } });
    assert.equal((await staff.call(`/api/admin/support-team/${fresh.json.agent.id}`, { method: "DELETE" })).status, 200);
    assert.equal(q("SELECT COUNT(*) n FROM support_agents WHERE display_name = 'Temp'")[0].n, 0);
  });

  await check("19 flooding is rate-limited", async () => {
    const b = browser();
    const statuses = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await send(b, `msg ${i}`, cid())).status);
    assert.ok(statuses.includes(429), `statuses: ${statuses.join(",")}`);
    assert.ok(statuses.slice(0, 20).every((s) => s === 201));
  });

  await check("20 message ids are random and unguessable", () => {
    const ids = q("SELECT id FROM chat_messages ORDER BY created_at").map((r) => r.id);
    assert.ok(ids.every((id) => /^msg_[A-Za-z0-9_-]{16}$/.test(id)));
    assert.equal(new Set(ids).size, ids.length);
  });

  await check("21 deleting a customer account removes their chat with it", async () => {
    const userId = q("SELECT id FROM users WHERE email = ?", userEmail)[0].id;
    const r = await staff.call(`/api/admin/users/${userId}`, { method: "DELETE", body: { confirmEmail: userEmail } });
    assert.equal(r.status, 200, r.text);
    assert.equal(q("SELECT COUNT(*) n FROM chat_conversations WHERE user_id = ?", userId)[0].n, 0);
    assert.equal(q("SELECT COUNT(*) n FROM chat_messages m LEFT JOIN chat_conversations c ON c.id = m.conversation_id WHERE c.id IS NULL")[0].n, 0, "no orphaned messages");
  });

  assert.doesNotMatch(serverLog, /thinnest pages|onerror/, "message text never reaches the server log");
  console.log(`live chat: passed (${passed} checks)`);
} finally {
  server.kill();
  await mail.close();
  await rm(dataDir, { recursive: true, force: true });
}
