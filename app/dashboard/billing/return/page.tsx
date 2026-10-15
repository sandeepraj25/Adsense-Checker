import type { Metadata } from "next";
import {
  BadgeCheck,
  Clock,
  CreditCard,
  FileDown,
  Radar,
  XCircle,
} from "lucide-react";

import { PageHeading } from "@/components/dashboard/PageHeading";
import { ButtonLink } from "@/components/ui/Button";
import { requireUser } from "@/lib/auth/guard";
import { findPaymentByOrderId, findSubscription, listPayments, markPaymentFailed } from "@/lib/db/billing";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { verifyCheckout } from "@/lib/payments";

export const metadata: Metadata = {
  title: "Finishing checkout",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** A gateway may repeat a query key; only the first value is meaningful. */
function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

const HALF_HOUR = 1_800_000;

/**
 * Where the hosted gateways land after the customer leaves the site.
 *
 * Cashfree appends `?order_id={order_id}`, PayPal returns `?token=<orderId>`
 * with a `PayerID`, and PayPal's cancel URL carries `?cancelled=1` and
 * nothing else. All three are treated the same way: the query string is
 * only ever used to find the order, and the decision to grant a plan comes
 * from `verifyCheckout`, which asks the gateway server-to-server. A forged
 * return URL therefore buys nothing — the worst it can do is show this
 * page a failure for an order the visitor does not own.
 */
export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();

  const cancelled = first(params.cancelled) === "1";
  const orderId =
    first(params.order_id) || first(params.orderId) || first(params.token);

  // ── the customer backed out ─────────────────────────────────────
  if (cancelled && !orderId) {
    // PayPal's cancel URL carries no order id, so close the newest order
    // this account opened in the last half hour. The update is guarded on
    // status='created', so it can never touch a payment that went through.
    const open = listPayments(user.id).find(
      (payment) =>
        payment.status === "created" &&
        Date.now() - payment.createdAt < HALF_HOUR,
    );
    if (open) markPaymentFailed(open.orderId, "Cancelled at checkout", "cancelled");

    return (
      <Outcome
        tone="neutral"
        icon={<XCircle className="size-5 text-cloud-400" aria-hidden />}
        eyebrow="Checkout cancelled"
        title="Nothing was charged"
        body="You left the payment page before it completed, so no money moved and your plan is unchanged. You can start again whenever you like."
        primary={{ label: "Back to plans", href: "/pricing" }}
        secondary={{ label: "Billing", href: "/dashboard/billing" }}
      />
    );
  }

  if (!orderId) {
    return (
      <Outcome
        tone="neutral"
        icon={<CreditCard className="size-5 text-cloud-400" aria-hidden />}
        eyebrow="Checkout"
        title="There is nothing to confirm here"
        body="This page finishes a payment that was started on the pricing page. It was opened without an order, so there is nothing to check. If you paid and the plan has not appeared, your billing page will show it as soon as the gateway confirms it."
        primary={{ label: "Billing", href: "/dashboard/billing" }}
        secondary={{ label: "See plans", href: "/pricing" }}
      />
    );
  }

  const result = await verifyCheckout({
    userId: user.id,
    orderId,
    // The adapter is handed exactly what the gateway sent, minus nothing.
    payload: { ...params, order_id: orderId },
  });

  // ── settled ─────────────────────────────────────────────────────
  if (result.ok) {
    const subscription = findSubscription(result.subscriptionId);

    return (
      <Outcome
        tone="pass"
        icon={<BadgeCheck className="size-5 text-mint-400" aria-hidden />}
        eyebrow={result.status === "already" ? "Already confirmed" : "Payment confirmed"}
        title={
          subscription
            ? `${subscription.planName} is active`
            : "Your plan is active"
        }
        body={
          subscription
            ? `${formatMoney(subscription.amountPaise, subscription.currency)} per ${subscription.billingCycle === "yearly" ? "year" : "month"}. You have ${subscription.scanLimit} scans for this billing month, and the allowance resets on ${formatDate(subscription.cycleEnd)}. The plan runs until ${formatDate(subscription.expiresAt)} and won’t renew automatically.`
            : "The payment was verified with the gateway and your plan has been activated."
        }
        note={
          result.simulated
            ? "This was a simulated payment. No money moved and the record is marked as a test payment."
            : undefined
        }
        primary={{ label: "Run a scan", href: "/dashboard/checker", icon: "scan" }}
        secondary={
          result.invoiceId
            ? {
                label: "View invoice",
                href: `/dashboard/billing/invoices/${result.invoiceId}`,
                icon: "invoice",
              }
            : { label: "Billing", href: "/dashboard/billing" }
        }
      />
    );
  }

  // ── the gateway has not finished yet ────────────────────────────
  if (result.pending) {
    return (
      <Outcome
        tone="warn"
        icon={<Clock className="size-5 text-amber-400" aria-hidden />}
        eyebrow="Payment settling"
        title="This payment is still being confirmed"
        body="The gateway has taken your payment but has not finished confirming it to us. We never activate a plan on an unconfirmed payment, so this page cannot grant it yet — the confirmation usually arrives within a minute or two and your billing page will update on its own."
        note="There is nothing you need to do, and you should not pay again."
        primary={{ label: "Billing", href: "/dashboard/billing" }}
        secondary={{ label: "Dashboard", href: "/dashboard" }}
      />
    );
  }

  // ── refused ─────────────────────────────────────────────────────
  // Back to checkout for the same plan, when this order is the visitor's.
  const failed = findPaymentByOrderId(orderId);
  const retryHref =
    failed && failed.userId === user.id ? `/checkout?plan=${encodeURIComponent(failed.planId)}` : "/pricing";

  return (
    <Outcome
      tone="fail"
      icon={<XCircle className="size-5 text-rose-400" aria-hidden />}
      eyebrow="Payment not completed"
      title="We could not confirm this payment"
      body={result.message}
      note="If money did leave your account, the gateway's own confirmation will settle it and the plan will appear on your billing page without a second payment."
      primary={{ label: "Try again", href: retryHref }}
      secondary={{ label: "Billing", href: "/dashboard/billing" }}
    />
  );
}

/* ── presentation ─────────────────────────────────────────────────── */

type Action = { label: string; href: string; icon?: "scan" | "invoice" };

const toneRing: Record<"neutral" | "pass" | "warn" | "fail", string> = {
  neutral: "border-ink-700 bg-ink-900",
  pass: "border-mint-400/25 bg-mint-400/[0.07]",
  warn: "border-amber-400/25 bg-amber-400/[0.06]",
  fail: "border-rose-400/25 bg-rose-400/[0.06]",
};

function Outcome({
  tone,
  icon,
  eyebrow,
  title,
  body,
  note,
  primary,
  secondary,
}: {
  tone: "neutral" | "pass" | "warn" | "fail";
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: string;
  note?: string;
  primary: Action;
  secondary: Action;
}) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeading eyebrow="Checkout" title="Finishing your payment" />

      <div className="glass edge-light relative overflow-hidden rounded-xl p-6 sm:p-8">
        <span
          className={`grid size-11 place-items-center rounded-xl border ${toneRing[tone]}`}
        >
          {icon}
        </span>

        <p className="t-eyebrow mt-5 text-cloud-600">{eyebrow}</p>
        <h2 className="t-display mt-2 text-[1.5rem] leading-tight text-cloud-50">
          {title}
        </h2>
        <p className="mt-3 max-w-xl text-[0.9375rem] leading-relaxed text-cloud-400">
          {body}
        </p>

        {note ? (
          <p className="mt-3 max-w-xl text-[0.875rem] leading-relaxed text-cloud-600">
            {note}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2.5">
          <ButtonLink href={primary.href} size="md">
            {primary.icon === "scan" ? (
              <Radar className="size-4" aria-hidden />
            ) : primary.icon === "invoice" ? (
              <FileDown className="size-4" aria-hidden />
            ) : null}
            {primary.label}
          </ButtonLink>
          <ButtonLink href={secondary.href} size="md" variant="ghost">
            {secondary.icon === "invoice" ? (
              <FileDown className="size-4" aria-hidden />
            ) : null}
            {secondary.label}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
