import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PrintButton } from "@/components/billing/PrintButton";
import { PaymentBadge } from "@/components/ui/Badge";
import { Logomark } from "@/components/illustrations/Logomark";
import { requireUser } from "@/lib/auth/guard";
import { findInvoice, findPayment, findSubscription } from "@/lib/db/billing";
import { gatewayLabel } from "@/lib/payments";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatMoneyExact } from "@/lib/money";
import { APP_URL } from "@/lib/env";

export const metadata: Metadata = {
  title: "Invoice",
};

export const dynamic = "force-dynamic";

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const invoice = findInvoice(id);
  // Ownership is checked before anything is rendered: someone else's
  // invoice must be indistinguishable from one that does not exist.
  if (!invoice || invoice.userId !== user.id) notFound();

  const payment = findPayment(invoice.paymentId);
  const subscription = invoice.subscriptionId
    ? findSubscription(invoice.subscriptionId)
    : null;

  const host = APP_URL.replace(/^https?:\/\//, "");

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-4">
        <Link
          href="/dashboard/billing"
          className="inline-flex items-center gap-1.5 text-[0.875rem] text-cloud-600 transition-colors hover:text-cloud-200"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Billing
        </Link>
        <PrintButton label="Download invoice" />
      </div>

      {/* The invoice itself. Kept on one printable sheet. */}
      <article className="glass print-sheet rounded-xl p-6 sm:p-9">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b border-ink-700 pb-6">
          <div>
            <div className="flex items-center gap-2.5">
              <Logomark size={26} />
              <span className="t-display text-[1.15rem] text-cloud-50">
                AdSense Checker
              </span>
            </div>
            <p className="mt-3 text-[0.8125rem] leading-relaxed text-cloud-600">
              AdSense eligibility audits
              <br />
              {host}
            </p>
          </div>

          <div className="text-right">
            <p className="t-eyebrow text-cloud-600">Invoice</p>
            <p className="t-data mt-2 text-[1.05rem] text-cloud-50">
              {invoice.number}
            </p>
            <p className="mt-2 text-[0.8125rem] text-cloud-600">
              Issued {formatDate(invoice.issuedAt)}
            </p>
            {payment ? (
              <div className="mt-2.5 flex justify-end">
                <PaymentBadge status={payment.status} />
              </div>
            ) : null}
          </div>
        </header>

        <section className="grid gap-6 py-6 sm:grid-cols-2">
          <div>
            <p className="text-[0.8125rem] font-medium text-cloud-600">Billed to</p>
            <p className="mt-2 text-[0.9375rem] text-cloud-50">
              {invoice.billingName}
            </p>
            <p className="t-data mt-1 text-[0.8125rem] break-all text-cloud-400">
              {invoice.billingEmail}
            </p>
            {payment?.billingPhone ? (
              <p className="t-data mt-1 text-[0.8125rem] text-cloud-400">
                {payment.billingPhone}
              </p>
            ) : null}
          </div>

          <div className="sm:text-right">
            <p className="text-[0.8125rem] font-medium text-cloud-600">
              Service period
            </p>
            <p className="mt-2 text-[0.9375rem] text-cloud-50">
              {formatDate(invoice.periodStart)} — {formatDate(invoice.periodEnd)}
            </p>
            {subscription ? (
              <p className="mt-1 text-[0.8125rem] text-cloud-400">
                One billing month · {subscription.scanLimit} scans
              </p>
            ) : (
              <p className="mt-1 text-[0.8125rem] text-cloud-400">
                One billing month
              </p>
            )}
          </div>
        </section>

        {/* line items */}
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-y border-ink-700">
              <th className="t-eyebrow py-3 text-[0.75rem] font-normal text-cloud-600">
                Description
              </th>
              <th className="t-eyebrow py-3 text-right text-[0.75rem] font-normal text-cloud-600">
                Qty
              </th>
              <th className="t-eyebrow py-3 text-right text-[0.75rem] font-normal text-cloud-600">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-ink-700">
              <td className="py-4 align-top">
                <p className="text-[0.9375rem] text-cloud-50">
                  {invoice.planName} plan — monthly subscription
                </p>
                <p className="mt-1 max-w-sm text-[0.8125rem] leading-relaxed text-cloud-600">
                  {subscription
                    ? `${subscription.scanLimit} website scans and ${
                        subscription.siteLimit === null
                          ? "unlimited websites"
                          : `${subscription.siteLimit} website${subscription.siteLimit === 1 ? "" : "s"}`
                      } for the billing month shown above.`
                    : "Website eligibility scans for the billing month shown above."}
                </p>
              </td>
              <td className="t-data py-4 text-right align-top text-[0.875rem] text-cloud-200">
                1
              </td>
              <td className="t-data py-4 text-right align-top text-[0.875rem] text-cloud-200">
                {formatMoneyExact(invoice.amountPaise, invoice.currency)}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td className="pt-4 text-right text-[0.875rem] text-cloud-400">
                Total
              </td>
              <td className="t-data pt-4 text-right text-[1.15rem] text-cloud-50">
                {formatMoneyExact(invoice.amountPaise, invoice.currency)}
              </td>
            </tr>
            <tr>
              <td />
              <td className="pt-1.5 text-right text-[0.75rem] text-cloud-600">
                Paid
              </td>
              <td className="t-data pt-1.5 text-right text-[0.8125rem] text-cloud-600">
                {invoice.currency}
              </td>
            </tr>
          </tfoot>
        </table>

        {/* payment trail */}
        <section className="mt-8 border-t border-ink-700 pt-6">
          <p className="text-[0.8125rem] font-medium text-cloud-600">Payment</p>
          <dl className="mt-3 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            <Line label="Gateway">
              {payment ? gatewayLabel(payment.gateway) : "—"}
            </Line>
            <Line label="Method">
              {payment?.mode === "mock"
                ? "Test payment (simulated)"
                : (payment?.method ?? "—")}
            </Line>
            <Line label="Paid on">
              {payment?.verifiedAt
                ? formatDateTime(payment.verifiedAt)
                : formatDateTime(invoice.issuedAt)}
            </Line>
            <Line label="Payment ID" mono>
              {payment?.paymentId ?? "—"}
            </Line>
            <Line label="Order ID" mono>
              {payment?.orderId ?? "—"}
            </Line>
          </dl>
        </section>

        <p className="mt-8 border-t border-ink-700 pt-5 text-[0.75rem] leading-relaxed text-cloud-600">
          This document is a receipt for one billing month of a monthly
          subscription. No tax is itemised because no tax registration is
          configured for this deployment — add your legal entity name,
          registered address and GSTIN before issuing invoices to customers.
          Card, UPI and account details are held by{" "}
          {payment ? gatewayLabel(payment.gateway) : "the payment gateway"} and
          were never stored by AdSense Checker.
        </p>
      </article>
    </div>
  );
}

function Line({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[0.8125rem] text-cloud-600">{label}</dt>
      <dd
        className={
          mono
            ? "t-data text-[0.75rem] break-all text-cloud-200"
            : "text-[0.875rem] text-cloud-200"
        }
      >
        {children}
      </dd>
    </div>
  );
}
