import type { EmailMessage } from "@/lib/email";
import { escapeHtml, layout } from "@/lib/email/templates";
import { formatMoneyExact } from "@/lib/money";

import type { AlertPayload } from "./notify";

/**
 * The two alert emails: a plain table of facts that reads on a phone,
 * with the same facts as text. Fields that are not known are left out
 * rather than shown as blanks. No credential of any kind is ever part of
 * the payload these are built from.
 */

const BRAND = "[AdSense Checker]";

function stamp(ms: number | undefined): string | null {
  if (!ms) return null;
  return `${new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(ms)} IST`;
}

const GATEWAY_LABEL: Record<string, string> = { razorpay: "Razorpay", cashfree: "Cashfree", paypal: "PayPal" };

export function renderAlert(p: AlertPayload, to: string): EmailMessage {
  const amount = formatMoneyExact(p.expectedAmountMinor, p.currency);
  const rows: [string, string | null][] =
    p.type === "payment_failed"
      ? [
          ["Alert", "Payment failed"],
          ["Customer", p.customerName],
          ["Email", p.customerEmail],
          ["Phone", p.customerPhone],
          ["Account ID", p.userId],
          ["Plan", `${p.planName} (${p.planId})`],
          ["Currency", p.currency],
          ["Expected amount", amount],
          ["Amount charged", "None — the provider reported the payment as failed"],
          ["Gateway", p.gateway ? GATEWAY_LABEL[p.gateway] ?? p.gateway : null],
          ["Order ID", p.orderId ?? null],
          ["Gateway payment ID", p.gatewayPaymentId ?? null],
          ["Failure reason", p.failureReason ?? null],
          ["Payment status", "Failed (confirmed by the provider)"],
          ["Attempt started", stamp(p.attemptedAt)],
          ["Failed at", stamp(p.failedAt)],
          ["Earlier abandoned alert", p.previouslyAbandonedAt ? `Yes — this checkout was flagged as abandoned on ${stamp(p.previouslyAbandonedAt)}; the customer came back and tried to pay.` : null],
        ]
      : [
          ["Alert", "Abandoned checkout"],
          ["Customer", p.customerName],
          ["Email", p.customerEmail],
          ["Phone", p.customerPhone],
          ["Account ID", p.userId],
          ["Plan", `${p.planName} (${p.planId})`],
          ["Currency", p.currency],
          ["Expected amount", amount],
          ["Payment attempted", "No — Pay was never pressed"],
          ["Checkout record", p.checkoutId ?? null],
          ["Details last saved", stamp(p.detailsSavedAt)],
          ["Detected", stamp(p.detectedAt)],
        ];
  const shown = rows.filter((row): row is [string, string] => Boolean(row[1]));

  const subject =
    p.type === "payment_failed"
      ? `${BRAND} Payment Failed — ${p.planName} Plan — Order #${p.orderId}`
      : `${BRAND} Abandoned Checkout — ${p.planName} Plan`;

  const heading = p.type === "payment_failed" ? "A payment failed" : "A checkout was abandoned";
  const intro =
    p.type === "payment_failed"
      ? `${p.customerName ?? "A customer"} tried to buy ${p.planName} and the payment provider reported the payment as failed. Nothing was charged and no plan was granted.`
      : `${p.customerName ?? "A customer"} entered their billing details for ${p.planName} but didn't start a payment.`;

  const html = layout(
    subject,
    `<h1 style="margin:0 0 8px;font-size:20px;line-height:26px;color:#18181b;">${escapeHtml(heading)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:#52525b;">${escapeHtml(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:20px;">
${shown
  .map(
    ([label, value]) =>
      `<tr><td style="padding:8px 12px 8px 0;border-top:1px solid #f1f5f9;color:#71717a;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:8px 0;border-top:1px solid #f1f5f9;color:#18181b;word-break:break-word;">${escapeHtml(value)}</td></tr>`,
  )
  .join("\n")}
</table>
<p style="margin:20px 0 8px;"><a href="${escapeHtml(p.adminUrl)}" style="display:inline-block;padding:10px 16px;background:#4f46e5;border-radius:8px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Open in the admin panel</a></p>`,
    `Sent to ${to} because it is set as the Payment & Checkout Alert Email in Admin → Notifications.`,
  );

  const text = [
    heading,
    "",
    intro,
    "",
    ...shown.map(([label, value]) => `${label}: ${value}`),
    "",
    `Admin panel: ${p.adminUrl}`,
  ].join("\n");

  return { to, subject, text, html };
}
