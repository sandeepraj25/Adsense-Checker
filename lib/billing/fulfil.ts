import { tx } from "@/lib/db";
import { findUserById } from "@/lib/db/accounts";
import {
  attachInvoiceToSubscription,
  createInvoice,
  createSubscription,
  findInvoiceByPayment,
  findPaymentByOrderId,
  findSubscription,
  markPaymentPaid,
} from "@/lib/db/billing";
import { getPlan } from "@/lib/plan-catalogue";

/**
 * The single place a payment turns into entitlement.
 *
 * Every gateway lands here, and so does every webhook, which is what
 * makes duplicate delivery harmless: the whole body runs inside one
 * `BEGIN IMMEDIATE` transaction, re-reads the payment row under that
 * write lock, and returns early if someone already fulfilled it. The
 * second caller therefore observes `already` instead of minting a second
 * subscription.
 *
 * Nothing about the caller is trusted. The plan, the price and the
 * currency all come from our own payment row; the gateway's reported
 * amount is only ever compared against it, never substituted for it.
 */

export type FulfilResult =
  | {
      status: "fulfilled" | "already";
      subscriptionId: string;
      invoiceId: string | null;
      planId: string;
    }
  | { status: "not_found" }
  | { status: "closed"; reason: string }
  | { status: "mismatch"; reason: string };

export function fulfilPayment(input: {
  orderId: string;
  /** The gateway's own id for the captured payment. */
  gatewayPaymentId: string;
  method?: string | null;
  /** Amount the gateway reports, cross-checked against what we charged. */
  observedAmountPaise?: number | null;
  observedCurrency?: string | null;
  /** The gateway's own status string, kept for support and reconciliation. */
  rawStatus?: string | null;
}): FulfilResult {
  return tx(() => {
    const payment = findPaymentByOrderId(input.orderId);
    if (!payment) return { status: "not_found" } as const;

    if (payment.status === "paid") {
      const invoice = findInvoiceByPayment(payment.id);
      return {
        status: "already",
        subscriptionId: payment.subscriptionId ?? "",
        invoiceId: invoice?.id ?? null,
        planId: payment.planId,
      } as const;
    }

    if (payment.status !== "created") {
      return {
        status: "closed",
        reason: `This order was already marked ${payment.status}.`,
      } as const;
    }

    // Never take the caller's word for the amount. If the figure the
    // gateway reports differs from what we recorded when creating the
    // order, something is wrong and no plan gets granted.
    if (
      typeof input.observedAmountPaise === "number" &&
      input.observedAmountPaise !== payment.amountPaise
    ) {
      return {
        status: "mismatch",
        reason: "The amount paid does not match the order.",
      } as const;
    }
    if (
      input.observedCurrency &&
      input.observedCurrency !== payment.currency
    ) {
      return {
        status: "mismatch",
        reason: "The currency does not match the order.",
      } as const;
    }

    const plan = getPlan(payment.planId);
    if (!plan) {
      return {
        status: "mismatch",
        reason: "That plan is no longer available.",
      } as const;
    }

    const user = findUserById(payment.userId);
    if (!user) return { status: "not_found" } as const;

    // amountPaise comes from the payment row, not from the plan: if an
    // admin re-priced the plan between checkout and capture, the person
    // is entitled to what they actually paid for.
    const subscription = createSubscription({
      userId: payment.userId,
      plan,
      paymentStatus: "paid",
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      paymentId: input.gatewayPaymentId,
      orderId: input.orderId,
      gateway: payment.gateway,
    });

    const claimed = markPaymentPaid({
      orderId: input.orderId,
      gatewayPaymentId: input.gatewayPaymentId,
      subscriptionId: subscription.id,
      method: input.method ?? null,
      rawStatus: input.rawStatus ?? null,
    });

    // Belt and braces: the guarded UPDATE is the real lock, so if it
    // did not match, abandon the whole transaction rather than leave a
    // subscription nobody paid for.
    if (!claimed) {
      throw new DuplicateFulfilment(input.orderId);
    }

    const invoice = createInvoice({
      userId: payment.userId,
      paymentId: payment.id,
      subscriptionId: subscription.id,
      // The details entered at checkout; orders from before checkout
      // collected them fall back to the account, as they always did.
      billingName: payment.billingName ?? user.name,
      billingEmail: payment.billingEmail ?? user.email,
      planName: plan.name,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      periodStart: subscription.startsAt,
      periodEnd: subscription.expiresAt,
    });

    attachInvoiceToSubscription(subscription.id, invoice.id);

    return {
      status: "fulfilled",
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      planId: plan.id,
    } as const;
  });
}

export class DuplicateFulfilment extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} was fulfilled concurrently`);
    this.name = "DuplicateFulfilment";
  }
}

/** Re-reads what fulfilment produced, for the success screen. */
export function fulfilmentSummary(subscriptionId: string) {
  return subscriptionId ? findSubscription(subscriptionId) : null;
}
