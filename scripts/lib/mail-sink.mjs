// A stand-in for the Resend HTTP API, for tests only.
//
// The app's real Resend provider (lib/email) posts to RESEND_API_URL, so
// pointing that at this server exercises the genuine delivery code path —
// request shape, auth header, failure handling — without an account.
// Every message the app sends is kept in memory for the test to read.

import { createServer } from "node:http";

export async function startMailSink() {
  const messages = [];
  /** Addresses for which the "provider" answers 500, to test failed delivery. */
  const failFor = new Set();

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* handled below */
      }
      const to = body?.to?.[0] ?? null;
      const authorised = req.headers.authorization === "Bearer re_test_key";
      if (req.method !== "POST" || !body || !to || !authorised) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "bad request" }));
        return;
      }
      if (failFor.has(to)) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "simulated outage" }));
        return;
      }
      messages.push({ ...body, to, at: Date.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `msg_${messages.length}` }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    messages,
    failFor,
    /** Environment for `next start` so the app delivers here. */
    env: {
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "AdSense Checker <no-reply@example.test>",
      RESEND_API_URL: `http://127.0.0.1:${port}/emails`,
    },
    /** All messages sent to an address, oldest first. */
    to(address) {
      return messages.filter((m) => m.to === address);
    },
    /** The code in the most recent verification email to an address. */
    latestCode(address) {
      const mine = this.to(address).filter((m) => /verification code/i.test(m.subject));
      const last = mine[mine.length - 1];
      return last ? last.text.match(/\b(\d{6})\b/)[1] : null;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Sign up and confirm the emailed code, as a person would. Returns the
 * session cookie set by the verify step (the sign-up step sets none).
 */
export async function registerVerified({ base, mail, name, email, password, next }) {
  const headers = { "content-type": "application/json", origin: base };
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, email, password, confirmPassword: password, next }),
    redirect: "manual",
  });
  if (signup.status !== 202) {
    throw new Error(`signup for ${email} returned ${signup.status}: ${await signup.text()}`);
  }
  const verifyCookie = signup.headers.get("set-cookie")?.split(";", 1)[0];
  if (!verifyCookie?.startsWith("aec_verify=")) throw new Error("no verification cookie");

  const code = mail.latestCode(email);
  if (!code) throw new Error(`no verification email reached ${email}`);

  const verify = await fetch(`${base}/api/auth/verify-email`, {
    method: "POST",
    headers: { ...headers, cookie: verifyCookie },
    body: JSON.stringify({ code }),
    redirect: "manual",
  });
  if (verify.status !== 200) {
    throw new Error(`verify for ${email} returned ${verify.status}: ${await verify.text()}`);
  }
  const raw = verify.headers.getSetCookie().find((c) => c.startsWith("aec_session="));
  if (!raw) throw new Error("verification did not start a session");
  return { cookie: raw.split(";", 1)[0], raw, body: await verify.json() };
}
