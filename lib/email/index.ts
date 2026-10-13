import { IS_PROD } from "@/lib/env";

/**
 * Outgoing email.
 *
 * One small interface so the rest of the app never knows which provider
 * is behind it. Configured entirely from the environment:
 *
 *   EMAIL_PROVIDER=resend   RESEND_API_KEY, EMAIL_FROM  (real delivery)
 *   EMAIL_PROVIDER=console  development only — prints the message to the
 *                           server terminal instead of sending it
 *
 * With nothing set, development falls back to `console` so the app runs
 * out of the box, and production reports "not configured" — sign-up then
 * refuses to start rather than pretending a code went out.
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
  | { configured: true; provider: string }
  | { configured: false; provider: string | null; problem: string };

const RESEND_DEFAULT_URL = "https://api.resend.com/emails";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function chosenProvider(): string {
  const explicit = env("EMAIL_PROVIDER").toLowerCase();
  if (explicit) return explicit;
  if (env("RESEND_API_KEY")) return "resend";
  return IS_PROD ? "" : "console";
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
    return { configured: true, provider: "console" };
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
    return { configured: true, provider: "resend" };
  }

  return {
    configured: false,
    provider: name,
    problem: `EMAIL_PROVIDER "${name}" is not supported. Use "resend" (or "console" in development).`,
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
  const provider = status.provider === "resend" ? resend : consoleProvider;
  return provider.send(message);
}
