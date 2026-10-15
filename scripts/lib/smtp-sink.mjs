// A small SMTP server for tests only.
//
// The app's real SMTP provider (lib/email, via Nodemailer) connects to it
// exactly as it would to smtp.gmail.com — EHLO, AUTH, MAIL FROM, RCPT TO,
// DATA — so the genuine delivery code path is exercised without a Google
// account. It speaks plain SMTP on 127.0.0.1 (no STARTTLS), which the app
// allows only for a loopback host; every other host must upgrade to TLS.
//
// Switches let a test make it behave like a failing provider:
//   badPassword   AUTH answers 535 5.7.8 (wrong or revoked App Password)
//   rejectRcpt    RCPT for these addresses answers 550 5.1.1
//   tempFail      RCPT answers 421 4.7.0 (try again later)
//   quota         DATA answers 550 5.4.5 (Gmail daily sending limit)

import { createServer } from "node:net";

export async function startSmtpSink({ user, pass, host = "127.0.0.1" }) {
  const messages = [];
  /** Every AUTH attempt: the credentials the app actually presented. */
  const logins = [];
  /** Greetings received (EHLO/HELO): proof a client actually reached this sink. */
  const greetings = [];
  const state = { badPassword: false, tempFail: false, quota: false, rejectRcpt: new Set() };

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let mode = "command"; // command | data | auth-plain | auth-login-user | auth-login-pass
    let authed = false;
    let loginUser = "";
    let envelope = { from: null, to: [] };
    let data = "";
    const say = (line) => socket.write(`${line}\r\n`);

    const tryAuth = (u, p) => {
      logins.push({ user: u, pass: p });
      if (!state.badPassword && u === user && p === pass) {
        authed = true;
        say("235 2.7.0 Accepted");
      } else {
        say("535 5.7.8 Username and Password not accepted");
      }
    };

    const command = (line) => {
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        greetings.push(line);
        say("250-sink.test");
        say("250-SIZE 10485760");
        say("250-8BITMIME");
        say("250 AUTH PLAIN LOGIN");
      } else if (upper.startsWith("AUTH PLAIN")) {
        const arg = line.slice(10).trim();
        if (!arg) {
          mode = "auth-plain";
          say("334 ");
        } else {
          const [, u, p] = Buffer.from(arg, "base64").toString("utf8").split("\0");
          tryAuth(u, p);
        }
      } else if (upper.startsWith("AUTH LOGIN")) {
        const arg = line.slice(10).trim();
        if (arg) {
          loginUser = Buffer.from(arg, "base64").toString("utf8");
          mode = "auth-login-pass";
          say("334 UGFzc3dvcmQ6");
        } else {
          mode = "auth-login-user";
          say("334 VXNlcm5hbWU6");
        }
      } else if (upper.startsWith("MAIL FROM:")) {
        if (!authed) return say("530 5.7.0 Authentication Required");
        envelope = { from: line.slice(10).trim().replace(/^<|>.*$/g, ""), to: [] };
        say("250 2.1.0 OK");
      } else if (upper.startsWith("RCPT TO:")) {
        const to = line.slice(8).trim().replace(/^<|>.*$/g, "").toLowerCase();
        if (state.tempFail) return say("421 4.7.0 Try again later, closing connection");
        if (state.rejectRcpt.has(to)) return say("550 5.1.1 The email account that you tried to reach does not exist");
        envelope.to.push(to);
        say("250 2.1.5 OK");
      } else if (upper === "DATA") {
        if (envelope.to.length === 0) return say("554 5.5.1 No valid recipients");
        mode = "data";
        data = "";
        say("354 Go ahead");
      } else if (upper === "RSET") {
        envelope = { from: null, to: [] };
        say("250 2.0.0 OK");
      } else if (upper === "NOOP") {
        say("250 2.0.0 OK");
      } else if (upper === "QUIT") {
        say("221 2.0.0 closing connection");
        socket.end();
      } else {
        say("502 5.5.1 Unrecognized command");
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        if (mode === "data") {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          mode = "command";
          if (state.quota) {
            say("550 5.4.5 Daily user sending limit exceeded");
            continue;
          }
          const raw = data.replace(/^\.\./gm, ".");
          for (const to of envelope.to) messages.push({ from: envelope.from, to, raw, ...parse(raw), at: Date.now() });
          say(`250 2.0.0 OK msg_${messages.length}`);
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (mode === "auth-plain") {
          mode = "command";
          const [, u, p] = Buffer.from(line, "base64").toString("utf8").split("\0");
          tryAuth(u, p);
        } else if (mode === "auth-login-user") {
          loginUser = Buffer.from(line, "base64").toString("utf8");
          mode = "auth-login-pass";
          say("334 UGFzc3dvcmQ6");
        } else if (mode === "auth-login-pass") {
          mode = "command";
          tryAuth(loginUser, Buffer.from(line, "base64").toString("utf8"));
        } else {
          command(line);
        }
      }
    });
    socket.on("error", () => {});
    say("220 sink.test ESMTP ready");
  });

  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();

  return {
    port,
    messages,
    logins,
    greetings,
    state,
    to(address) {
      return messages.filter((m) => m.to === address.toLowerCase());
    },
    /** The code in the most recent verification email to an address. */
    codeFor(address) {
      const last = this.to(address).at(-1);
      return last?.subject.match(/^(\d{6}) is your/)?.[1] ?? null;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ── just enough MIME to read what was sent ─────────────────────── */

function qp(text) {
  return text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodePart(headers, body) {
  const encoding = (headers.match(/content-transfer-encoding:\s*([^\r\n;]+)/i)?.[1] ?? "").trim().toLowerCase();
  if (encoding === "quoted-printable") return Buffer.from(qp(body), "latin1").toString("utf8");
  if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  return body;
}

function parse(raw) {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const body = raw.slice(split + 4);
  const header = (name) => head.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
  const boundary = head.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  let text = "";
  let html = "";
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const at = part.indexOf("\r\n\r\n");
      if (at === -1) continue;
      const partHead = part.slice(0, at);
      const partBody = part.slice(at + 4).replace(/\r\n$/, "");
      if (/content-type:\s*text\/plain/i.test(partHead)) text = decodePart(partHead, partBody);
      if (/content-type:\s*text\/html/i.test(partHead)) html = decodePart(partHead, partBody);
    }
  } else {
    text = decodePart(head, body);
  }
  return {
    subject: header("Subject"),
    fromHeader: header("From"),
    toHeader: header("To"),
    replyTo: header("Reply-To"),
    contentType: header("Content-Type"),
    text,
    html,
  };
}
