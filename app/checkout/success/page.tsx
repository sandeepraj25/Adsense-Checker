import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, Clock, XCircle } from "lucide-react";

import { ButtonLink } from "@/components/ui/Button";
import { requireUser } from "@/lib/auth/guard";
import { findInvoiceByPayment, findPaymentByOrderId, findSubscription } from "@/lib/db/billing";
import { normalizeDomain } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { gatewayLabel } from "@/lib/payments";
import { getPlan } from "@/lib/plan-catalogue";

export const metadata: Metadata = {
  title: "Payment status",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Where the checkout page lands after the gateway hands back.
 *
 * This page decides nothing. It reads the order's state as the server
 * recorded it — `paid` only ever comes from fulfilPayment after a
 * server-side verification or a signed webhook — and explains it. Someone
 * typing a different order id sees a 404, the same as for an order that
 * does not exist, so the URL cannot be used to look at other accounts.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; url?: string }>;
}) {
  const { order, url } = await searchParams;
  const user = await requireUser();

  const payment = order ? findPaymentByOrderId(order) : null;
  if (!payment || payment.userId !== user.id) notFound();

  const plan = getPlan(payment.planId);
  const planName = plan?.name ?? payment.planId;
  const carryUrl = normalizeDomain(url ?? "") ?? undefined;
  const retry = `/checkout?${new URLSearchParams({ plan: payment.planId, currency: payment.currency, ...(carryUrl ? { url: carryUrl } : {}) })}`;

  let body: React.ReactNode;

  if (payment.status === "paid") {
    const subscription = payment.subscriptionId ? findSubscription(payment.subscriptionId) : null;
    const invoice = findInvoiceByPayment(payment.id);
    body = (
      <Outcome
        icon={<BadgeCheck className="size-6 text-mint-400" aria-hidden />}
        tone="border-mint-400/25 bg-mint-400/[0.07]"
        title={`Payment confirmed — ${planName} is active`}
        lede={
          subscription
            ? `You have ${subscription.scanLimit} scans this billing month. Your plan runs until ${formatDate(subscription.expiresAt)} and won't renew automatically.`
            : "Your payment was verified and your plan is active."
        }
        rows={[
          ["Amount paid", formatMoney(payment.amountPaise, payment.currency)],
          ["Paid with", gatewayLabel(payment.gateway)],
          ["Order", payment.orderId],
          ...(payment.billingEmail ? ([["Invoice sent to", payment.billingEmail]] as [string, string][]) : []),
        ]}
        note={payment.mode === "mock" ? "This was a simulated test payment. No money moved." : undefined}
        primary={
          carryUrl
            ? { href: `/dashboard/checker?url=${encodeURIComponent(carryUrl)}&run=1`, label: `Scan ${carryUrl}` }
            : { href: "/dashboard/checker", label: "Run a scan" }
        }
        secondary={
          invoice
            ? { href: `/dashboard/billing/invoices/${invoice.id}`, label: "View invoice" }
            : { href: "/dashboard/billing", label: "Go to billing" }
        }
      />
    );
  } else if (payment.status === "created") {
    body = (
      <Outcome
        icon={<Clock className="size-6 text-amber-400" aria-hidden />}
        tone="border-amber-400/25 bg-amber-400/[0.06]"
        title="We're confirming your payment"
        lede={`${gatewayLabel(payment.gateway)} hasn't confirmed this payment to us yet. We only activate a plan after that confirmation — it usually arrives within a minute or two, and your billing page will update on its own.`}
        rows={[
          ["Amount", formatMoney(payment.amountPaise, payment.currency)],
          ["Order", payment.orderId],
        ]}
        note="Please don't pay again. If the payment went through, it will be applied to this order."
        primary={{ href: "/dashboard/billing", label: "Go to billing" }}
        secondary={{ href: "/dashboard", label: "Dashboard" }}
      />
    );
  } else {
    const cancelled = payment.status === "cancelled";
    body = (
      <Outcome
        icon={<XCircle className="size-6 text-rose-400" aria-hidden />}
        tone="border-rose-400/25 bg-rose-400/[0.06]"
        title={cancelled ? "Payment cancelled" : "Payment not completed"}
        lede={
          cancelled
            ? "You left the payment before it finished. Nothing was charged and your plan is unchanged."
            : `${payment.failureReason ?? "The payment provider did not confirm this payment."} Your plan is unchanged.`
        }
        rows={[["Order", payment.orderId]]}
        note="Trying again opens a new order, so you can't be charged twice for this one."
        primary={{ href: retry, label: "Try again" }}
        secondary={{ href: "/dashboard/billing", label: "Go to billing" }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-ink-900">
      <header className="border-b border-ink-700 bg-white">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center px-4 sm:px-8">
          <Link href="/" aria-label="Home">
            <Image src="/logo.png" alt="AdSense Checker" width={2078} height={757} sizes="110px" className="h-10 w-auto" priority />
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-xl px-4 py-10 sm:py-14">{body}</main>
    </div>
  );
}

function Outcome({
  icon,
  tone,
  title,
  lede,
  rows,
  note,
  primary,
  secondary,
}: {
  icon: React.ReactNode;
  tone: string;
  title: string;
  lede: string;
  rows: [string, string][];
  note?: string;
  primary: { href: string; label: string };
  secondary: { href: string; label: string };
}) {
  return (
    <section role="status" className="rounded-xl border border-ink-700 bg-white p-6 sm:p-8">
      <span className={`grid size-12 place-items-center rounded-xl border ${tone}`}>{icon}</span>
      <h1 className="mt-5 text-[1.5rem] font-semibold leading-tight text-cloud-50">{title}</h1>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-cloud-300">{lede}</p>

      <dl className="mt-5 divide-y divide-ink-850 border-y border-ink-700">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2.5 text-[0.875rem]">
            <dt className="text-cloud-400">{label}</dt>
            <dd className="min-w-0 break-all font-medium text-cloud-50">{value}</dd>
          </div>
        ))}
      </dl>

      {note ? <p className="mt-4 text-[0.875rem] leading-relaxed text-cloud-400">{note}</p> : null}

      <div className="mt-6 flex flex-wrap gap-2.5">
        <ButtonLink href={primary.href} size="md">
          {primary.label}
        </ButtonLink>
        <ButtonLink href={secondary.href} size="md" variant="ghost">
          {secondary.label}
        </ButtonLink>
      </div>
    </section>
  );
}
