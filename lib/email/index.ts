import nodemailer, { type Transporter } from "nodemailer";

import { IS_PROD } from "@/lib/env";

/**
 * Outgoing email.
 *
 * One small interface so the rest of the app never knows which provider
 * is behind it. Configured entirely from the environment:
 *
 *   EMAIL_PROVIDER=smtp     Google SMTP (smtp.gmail.com) or any SMTP server:
 *                           SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER,
 *                           SMTP_APP_PASSWORD, EMAIL_FROM  (real delivery)
 *   EMAIL_PROVIDER=resend   RESEND_API_KEY, EMAIL_FROM  (real delivery)
 *   EMAIL_PROVIDER=console  development only — prints the message to the
 *                           server terminal instead of sending it
 *
 * With EMAIL_PROVIDER unset, SMTP_USER selects smtp and RESEND_API_KEY
 * selects resend. With nothing set, development falls back to `console`
 * so the app runs out of the box, and production reports "not configured"
 * — sign-up then refuses to start rather than pretending a code went out.
 *
 * A message counts as sent only when the provider accepted it: for SMTP,
 * the server must list the recipient as accepted and reject none.
 *
 * Nothing here logs a message body in production: a verification email
 * contains a code, and logs are not a place for codes.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SendResult =
  | { ok: true; provider: string; id: string | null }
  | {
      ok: false;
      provider: string;
      reason: string;
      /**
       * Worth trying again later: a rate limit, a provider-side error or a
       * network failure. False for a rejection that will not change on its
       * own (bad key, unverified sender, invalid address) or no provider.
       */
      transient?: boolean;
    };

type Provider = {
  name: string;
  send(message: EmailMessage): Promise<SendResult>;
};

export type EmailStatus =
  | { configured: true; provider: string; label: string }
  | { configured: false; provider: string | null; problem: string };

const RESEND_DEFAULT_URL = "https://api.resend.com/emails";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function chosenProvider(): string {
  const explicit = env("EMAIL_PROVIDER").toLowerCase();
  if (explicit) return explicit;
  if (env("SMTP_USER")) return "smtp";
  if (env("RESEND_API_KEY")) return "resend";
  return IS_PROD ? "" : "console";
}

/* ── SMTP settings ──────────────────────────────────────────────── */

const GMAIL_HOST = "smtp.gmail.com";

type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Reads and checks the SMTP variables. Never returns or prints the password in a problem. */
export function smtpSettings(): { ok: true; settings: SmtpSettings } | { ok: false; problem: string } {
  const host = (env("SMTP_HOST") || GMAIL_HOST).toLowerCase();
  const portText = env("SMTP_PORT") || "587";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    return { ok: false, problem: `SMTP_PORT "${portText.slice(0, 10)}" is not a port number. Use 587 (STARTTLS) or 465 (TLS).` };
  }

  const secureText = env("SMTP_SECURE").toLowerCase();
  if (secureText && secureText !== "true" && secureText !== "false") {
    return { ok: false, problem: 'SMTP_SECURE must be "true" or "false".' };
  }
  // Port 465 speaks TLS from the first byte; 587 starts plain and upgrades with STARTTLS.
  const secure = secureText ? secureText === "true" : port === 465;
  if (port === 465 && !secure) {
    return { ok: false, problem: "SMTP_PORT is 465, which needs SMTP_SECURE=true (TLS from the start)." };
  }
  if (port === 587 && secure) {
    return { ok: false, problem: "SMTP_PORT is 587, which needs SMTP_SECURE=false (the connection is upgraded with STARTTLS)." };
  }

  const user = env("SMTP_USER");
  if (!user) return { ok: false, problem: "SMTP_USER is not set. Use the full Gmail or Google Workspace address." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
    return { ok: false, problem: "SMTP_USER must be the full email address of the sending account." };
  }

  // Google shows App Passwords in four groups of four; the spaces are not part of it.
  const pass = env("SMTP_APP_PASSWORD").replace(/\s+/g, "");
  if (!pass) {
    return { ok: false, problem: "SMTP_APP_PASSWORD is not set. Create a Google App Password for the sending account." };
  }
  if (host === GMAIL_HOST && !/^[a-z]{16}$/i.test(pass)) {
    return {
      ok: false,
      problem:
        "SMTP_APP_PASSWORD doesn't look like a Google App Password (16 letters). Use an App Password, never the account's normal password.",
    };
  }

  const from = env("EMAIL_FROM") || user;
  return { ok: true, settings: { host, port, secure, user, pass, from } };
}

export function emailStatus(): EmailStatus {
  const name = chosenProvider();

  if (!name) {
    return {
      configured: false,
      provider: null,
      problem: "No email provider is configured. Set EMAIL_PROVIDER=resend, RESEND_API_KEY and EMAIL_FROM.",
    };
  }

  if (name === "console") {
    if (IS_PROD) {
      return {
        configured: false,
        provider: "console",
        problem: "EMAIL_PROVIDER=console is for development only and is refused in production.",
      };
    }
    return { configured: true, provider: "console", label: "the server log (development)" };
  }

  if (name === "smtp") {
    const smtp = smtpSettings();
    if (!smtp.ok) return { configured: false, provider: "smtp", problem: smtp.problem };
    const { host, port } = smtp.settings;
    return {
      configured: true,
      provider: "smtp",
      label: host === GMAIL_HOST ? `Google SMTP (${host}:${port})` : `SMTP (${host}:${port})`,
    };
  }

  if (name === "resend") {
    if (!env("RESEND_API_KEY")) {
      return { configured: false, provider: "resend", problem: "RESEND_API_KEY is not set." };
    }
    if (!env("EMAIL_FROM")) {
      return {
        configured: false,
        provider: "resend",
        problem: 'EMAIL_FROM is not set (for example "AdSense Checker <no-reply@yourdomain.com>").',
      };
    }
    return { configured: true, provider: "resend", label: "Resend" };
  }

  return {
    configured: false,
    provider: name,
    problem: `EMAIL_PROVIDER "${name}" is not supported. Use "smtp" or "resend" (or "console" in development).`,
  };
}

const resend: Provider = {
  name: "resend",
  async send(message) {
    const url = env("RESEND_API_URL") || RESEND_DEFAULT_URL;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("RESEND_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env("EMAIL_FROM"),
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(env("EMAIL_REPLY_TO") ? { reply_to: env("EMAIL_REPLY_TO") } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });

      if (!res.ok) {
        // The status is enough to diagnose (401 bad key, 403 unverified
        // domain, 422 bad sender, 429 quota). The body is not logged.
        console.error(`[email] Resend rejected a message: HTTP ${res.status}`);
        return {
          ok: false,
          provider: "resend",
          reason: `HTTP ${res.status}`,
          transient: res.status === 429 || res.status >= 500,
        };
      }

      const data = (await res.json().catch(() => null)) as { id?: string } | null;
      return { ok: true, provider: "resend", id: data?.id ?? null };
    } catch (error) {
      const reason = error instanceof Error ? error.name : "network error";
      console.error(`[email] Could not reach Resend: ${reason}`);
      return { ok: false, provider: "resend", reason, transient: true };
    }
  },
};

/* ── SMTP (Google) ──────────────────────────────────────────────── */

let cached: { key: string; transport: Transporter } | null = null;

function smtpTransport(settings: SmtpSettings): Transporter {
  const key = [settings.host, settings.port, settings.secure, settings.user, settings.pass].join("\0");
  if (cached?.key === key) return cached.transport;
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    // On 587 the upgrade to TLS is mandatory: a server (or anything in
    // between) that doesn't offer STARTTLS is refused rather than sent the
    // password in the clear. Only a loopback test server is exempt.
    requireTLS: !settings.secure && !isLoopback(settings.host),
    auth: { user: settings.user, pass: settings.pass },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: settings.host },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  });
  cached = { key, transport };
  return transport;
}

type SmtpError = Error & { code?: string; responseCode?: number; response?: string };

/**
 * Turns a Nodemailer error into a reason an operator can act on. Only the
 * error code and SMTP status are used — never the server's free text, which
 * can echo addresses — and never the credentials.
 */
function describeSmtpError(error: unknown): { reason: string; transient: boolean } {
  const e = (error ?? {}) as SmtpError;
  const code = e.code ?? "";
  const status = typeof e.responseCode === "number" ? e.responseCode : null;
  const enhanced = typeof e.response === "string" ? (e.response.match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0] ?? null) : null;
  const tag = [code, status, enhanced].filter(Boolean).join(" ");

  if (code === "EAUTH" || status === 535 || status === 534) {
    return {
      reason: `SMTP sign-in was refused (${tag}). Check SMTP_USER and that SMTP_APP_PASSWORD is a current Google App Password for that account (2-Step Verification must be on).`,
      transient: false,
    };
  }
  if (code === "ETLS" || /certificate|ssl|tls/i.test(e.message ?? "")) {
    return {
      reason: `The secure connection to the SMTP server failed (${tag || "TLS"}). Use port 587 with SMTP_SECURE=false, or 465 with SMTP_SECURE=true.`,
      transient: false,
    };
  }
  if (code === "EENVELOPE" || status === 550 || status === 553 || status === 552) {
    // Gmail's "daily sending limit exceeded" is 550 5.4.5 and clears on its own.
    const quota = enhanced === "5.4.5";
    return {
      reason: quota
        ? `The sending account reached Gmail's daily sending limit (${tag}). Sending resumes automatically within 24 hours.`
        : `The SMTP server refused the sender or recipient (${tag}). Check EMAIL_FROM is the sending account or one of its verified aliases, and that the recipient address is valid.`,
      transient: quota,
    };
  }
  if (status !== null && status >= 400 && status < 500) {
    return { reason: `The SMTP server asked to try again later (${tag}).`, transient: true };
  }
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "EPROTOCOL"].includes(code)) {
    return {
      reason: `Could not reach the SMTP server (${tag}). Check SMTP_HOST and SMTP_PORT, and that the host allows outbound SMTP — Render's free instances block ports 25, 465 and 587.`,
      transient: true,
    };
  }
  return { reason: `The SMTP server did not accept the message (${tag || "unknown error"}).`, transient: true };
}

const smtp: Provider = {
  name: "smtp",
  async send(message) {
    const config = smtpSettings();
    if (!config.ok) return { ok: false, provider: "smtp", reason: config.problem };
    const { settings } = config;
    try {
      const info = await smtpTransport(settings).sendMail({
        from: settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(env("EMAIL_REPLY_TO") ? { replyTo: env("EMAIL_REPLY_TO") } : {}),
      });

      // Accepted means the server took responsibility for this recipient.
      const target = message.to.toLowerCase();
      const accepted = (info.accepted ?? []).map((a: unknown) =>
        (typeof a === "string" ? a : ((a as { address?: string })?.address ?? "")).toLowerCase(),
      );
      const rejected = info.rejected ?? [];
      if (!accepted.includes(target) || rejected.length > 0) {
        console.error("[email] SMTP server did not accept the recipient.");
        return { ok: false, provider: "smtp", reason: "The SMTP server did not accept the recipient.", transient: false };
      }
      return { ok: true, provider: "smtp", id: typeof info.messageId === "string" ? info.messageId : null };
    } catch (error) {
      const { reason, transient } = describeSmtpError(error);
      console.error(`[email] SMTP send failed: ${reason}`);
      return { ok: false, provider: "smtp", reason, transient };
    }
  },
};

const consoleProvider: Provider = {
  name: "console",
  async send(message) {
    // Development only (emailStatus refuses it in production). Printing the
    // text is the point: it is how you get the code without a mail account.
    console.info(
      [
        "",
        "──────── [email:dev] not sent — EMAIL_PROVIDER is console ────────",
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        "",
        message.text,
        "──────────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return { ok: true, provider: "console", id: null };
  },
};

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const status = emailStatus();
  if (!status.configured) {
    return { ok: false, provider: status.provider ?? "none", reason: status.problem };
  }
  const provider = status.provider === "smtp" ? smtp : status.provider === "resend" ? resend : consoleProvider;
  return provider.send(message);
}
