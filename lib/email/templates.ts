import type { EmailMessage } from "./index";

/**
 * Plain, mobile-friendly emails: one column, system fonts, inline styles
 * only (mail clients strip <style>), and a text part that says the same
 * thing for clients that do not render HTML.
 */

const PRODUCT = "AdSense Eligibility Checker";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function layout(
  title: string,
  body: string,
  footer = `You received this because this address was entered on ${PRODUCT}. If that wasn't you, you can ignore this email — no account is created without the code.`,
): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
<tr><td style="padding:28px 24px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 20px;font-size:14px;font-weight:600;color:#4f46e5;">${PRODUCT}</p>
${body}
</td></tr>
<tr><td style="padding:16px 24px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;border-top:1px solid #f1f5f9;">
<p style="margin:0;font-size:12px;line-height:18px;color:#71717a;">${escapeHtml(footer)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function verificationCodeEmail(input: {
  to: string;
  name: string;
  code: string;
  minutes: number;
}): EmailMessage {
  const first = input.name.split(/\s+/)[0] || "there";
  const subject = `${input.code} is your ${PRODUCT} verification code`;

  const text = [
    `Hi ${first},`,
    "",
    `Your verification code is: ${input.code}`,
    "",
    `Enter it on the verification page to finish creating your account. The code expires in ${input.minutes} minutes and can be used once.`,
    "",
    "Never share this code. We will never ask you for it by phone, chat or email.",
    "",
    `— ${PRODUCT}`,
  ].join("\n");

  const html = layout(
    subject,
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:28px;color:#18181b;">Verify your email</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:22px;color:#52525b;">Hi ${escapeHtml(first)}, enter this code to finish creating your account.</p>
<p style="margin:0 0 20px;padding:16px;background:#f1f5f9;border-radius:8px;text-align:center;font-size:32px;line-height:36px;letter-spacing:8px;font-weight:700;color:#18181b;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(input.code)}</p>
<p style="margin:0 0 12px;font-size:14px;line-height:20px;color:#52525b;">The code expires in <strong style="color:#18181b;">${input.minutes} minutes</strong> and works once.</p>
<p style="margin:0 0 8px;font-size:14px;line-height:20px;color:#52525b;"><strong style="color:#18181b;">Keep it private.</strong> Don't share this code with anyone — we will never ask you for it.</p>`,
  );

  return { to: input.to, subject, text, html };
}

/**
 * Sent instead of a code when someone signs up with an address that
 * already has an account. The person signing up sees exactly the same
 * screen either way, so sign-up cannot be used to test who is registered;
 * the real owner learns about it here.
 */
export function existingAccountEmail(input: {
  to: string;
  loginUrl: string;
}): EmailMessage {
  const subject = `You already have a ${PRODUCT} account`;

  const text = [
    "Hi,",
    "",
    "Someone — probably you — tried to create a new account with this email address, but it already has one. No new account was created and nothing about your existing account changed.",
    "",
    `Log in here: ${input.loginUrl}`,
    "",
    "If this wasn't you, you don't need to do anything.",
    "",
    `— ${PRODUCT}`,
  ].join("\n");

  const html = layout(
    subject,
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:28px;color:#18181b;">You already have an account</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:22px;color:#52525b;">Someone — probably you — tried to sign up again with this address. No new account was created and your existing account is unchanged.</p>
<p style="margin:0 0 20px;"><a href="${escapeHtml(input.loginUrl)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;border-radius:8px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Log in</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:20px;color:#52525b;">If this wasn't you, you don't need to do anything.</p>`,
  );

  return { to: input.to, subject, text, html };
}
