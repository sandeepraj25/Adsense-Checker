"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { AlertTriangle, LockKeyhole, ShieldCheck } from "lucide-react";
import { isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { CountryCode } from "libphonenumber-js";

import { Spinner } from "@/components/ui/Spinner";
import { validateBilling, type BillingErrors, type BillingInput } from "@/lib/billing-details";
import {
  openGateway,
  type ApiFailure,
  type OrderResponse,
  type VerifyOutcome,
} from "@/lib/checkout-client";
import { cn } from "@/lib/cn";
import { trackEvent } from "@/components/analytics/track";
import type { CheckoutOption } from "@/lib/payments";

export type CountryOption = { code: string; name: string; dial: string };

const LOGOS: Record<string, string> = {
  razorpay: "/razorpay.png",
  cashfree: "/cashfree.png",
  paypal: "/paypal.png",
};

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "with-gateway" }
  | { kind: "verifying" }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

function newAttemptId(): string {
  return crypto.randomUUID();
}

/**
 * The checkout form: billing details on the left, summary and payment
 * method on the right, one submit.
 *
 * Validation here is for instant feedback only — the order route runs the
 * same rules with full phone metadata and is the one that decides. The
 * price shown is the server's; nothing the browser sends can change what
 * is charged.
 *
 * Each purchase attempt carries a random id. A double click, a retried
 * request or a refresh-and-resubmit therefore maps to the same order on
 * the server. After a cancellation or a failure a fresh id is drawn, so
 * the retry opens a clean new order instead of reviving the old one.
 */
export function CheckoutForm({
  plan,
  options,
  countries,
  prefill,
  accountEmail,
  carryUrl,
  summary,
}: {
  /**
   * The price shown, in the site currency. Sent back with the order only so
   * the server can refuse it if the price or currency changed meanwhile —
   * the server always charges its own figure.
   */
  plan: { id: string; name: string; priceLabel: string; currency: string; amountMinor: number };
  options: CheckoutOption[];
  countries: CountryOption[];
  prefill: { name: string; email: string; country: string; phone: string };
  accountEmail: string;
  carryUrl?: string;
  summary: React.ReactNode;
}) {
  const router = useRouter();
  const formId = useId();
  const [values, setValues] = useState<BillingInput>(prefill);
  const [errors, setErrors] = useState<BillingErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof BillingInput, boolean>>>({});
  const [gatewayId, setGatewayId] = useState(options[0]?.id ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const attemptId = useRef<string>("");
  const errorSummary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    attemptId.current = newAttemptId();
  }, []);

  // Analytics: the checkout form was shown. The server ignores a repeat
  // for the same plan in the same visit, so a reload is not a second one.
  useEffect(() => {
    if (options.length > 0) trackEvent("checkout_started", { plan: plan.id, currency: plan.currency });
  }, [options.length, plan.id, plan.currency]);

  // Checkout progress: once every billing field is valid, save it (after
  // a pause in typing, and only when something changed) so the server can
  // notice a checkout left without pressing Pay. Nothing is charged or
  // created as an order by this; the server re-validates every field.
  const checkoutId = useRef<string | null>(null);
  const lastSaved = useRef<string>("");
  useEffect(() => {
    const result = validateBilling(
      values,
      (number, country) => parsePhoneNumberFromString(number, country),
      (value): value is CountryCode => isSupportedCountry(value),
    );
    if (!result.ok) return;
    const snapshot = JSON.stringify(values);
    if (snapshot === lastSaved.current) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/checkout/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkoutId: checkoutId.current, planId: plan.id, currency: plan.currency, billing: values }),
      })
        .then((res) => res.json())
        .then((data: { ok: boolean; checkoutId?: string }) => {
          if (data.ok && data.checkoutId) {
            checkoutId.current = data.checkoutId;
            lastSaved.current = snapshot;
          }
        })
        // Best effort: a failed save never blocks paying.
        .catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [values, plan.id, plan.currency]);

  const chosen = options.find((option) => option.id === gatewayId) ?? options[0];
  const busy = status.kind === "submitting" || status.kind === "with-gateway" || status.kind === "verifying";
  const differentEmail =
    values.email.trim().toLowerCase() !== accountEmail.toLowerCase() && values.email.trim() !== "";
  const dial = useMemo(
    () => countries.find((c) => c.code === values.country)?.dial ?? "",
    [countries, values.country],
  );

  function check(next: BillingInput) {
    const result = validateBilling(
      next,
      (number, country) => parsePhoneNumberFromString(number, country),
      (value): value is CountryCode => isSupportedCountry(value),
    );
    return result.ok ? {} : result.errors;
  }

  function update(field: keyof BillingInput, value: string) {
    const next = { ...values, [field]: value };
    setValues(next);
    if (touched[field] || errors[field]) setErrors(check(next));
    if (status.kind === "error" || status.kind === "cancelled") setStatus({ kind: "idle" });
  }

  function blur(field: keyof BillingInput) {
    setTouched((t) => ({ ...t, [field]: true }));
    setErrors(check(values));
  }

  function freshAttempt() {
    attemptId.current = newAttemptId();
  }

  function finish(outcome: VerifyOutcome) {
    if (outcome.kind === "failed") {
      freshAttempt();
      setStatus({ kind: "error", message: `${outcome.message} You can try again — you will not be charged twice.` });
      return;
    }
    // Confirmed or still settling: the success page reads the order's
    // state from the database and explains which.
    const query = new URLSearchParams({ order: outcome.orderId });
    if (carryUrl) query.set("url", carryUrl);
    router.push(`/checkout/success?${query.toString()}`);
    router.refresh();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !chosen) return;

    const found = check(values);
    setTouched({ name: true, email: true, country: true, phone: true });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setStatus({ kind: "error", message: "Check the highlighted billing details." });
      requestAnimationFrame(() => errorSummary.current?.focus());
      return;
    }

    setStatus({ kind: "submitting" });

    let order: OrderResponse;
    try {
      const res = await fetch("/api/checkout/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          currency: plan.currency,
          expectedAmount: plan.amountMinor,
          gateway: chosen.id,
          checkoutId: checkoutId.current,
          attemptId: attemptId.current,
          billing: values,
        }),
      });
      const data = (await res.json()) as OrderResponse | ApiFailure;

      if (!data.ok) {
        if (data.code === "UNAUTHENTICATED") {
          const back = new URLSearchParams({ plan: plan.id });
          if (carryUrl) back.set("url", carryUrl);
          router.push(`/login?next=${encodeURIComponent(`/checkout?${back.toString()}`)}`);
          return;
        }
        if (data.fields) setErrors(data.fields as BillingErrors);
        if (data.code === "CHECKOUT_ATTEMPT_USED") freshAttempt();
        if (data.code === "PRICE_CHANGED") {
          // Show the new price instead of charging a different one.
          setStatus({ kind: "error", message: data.message });
          router.refresh();
          return;
        }
        setStatus({ kind: "error", message: data.message });
        requestAnimationFrame(() => errorSummary.current?.focus());
        return;
      }
      order = data;
    } catch {
      // The same attempt id is kept: if the order did open, resubmitting
      // returns it rather than opening a second one.
      setStatus({
        kind: "error",
        message: "We could not reach the server. Check your connection and try again. Nothing has been charged.",
      });
      return;
    }

    setStatus({ kind: order.handoff.kind === "mock" ? "verifying" : "with-gateway" });

    await openGateway(order, {
      onVerified: (outcome) => {
        setStatus({ kind: "verifying" });
        finish(outcome);
      },
      onDismissed: () => {
        freshAttempt();
        setStatus({ kind: "cancelled" });
      },
      onUnavailable: (message) => {
        freshAttempt();
        setStatus({ kind: "error", message });
      },
    });
  }

  const fieldError = (field: keyof BillingInput) => (touched[field] || status.kind === "error" ? errors[field] : undefined);

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-describedby={`${formId}-status`}
      className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)] lg:items-start"
    >
      {/* ── Billing details ─────────────────────────────────────── */}
      <section aria-labelledby={`${formId}-billing`} className="rounded-xl border border-ink-700 bg-white p-5 sm:p-6">
        <h2 id={`${formId}-billing`} className="text-[1.0625rem] font-semibold text-cloud-50">
          Billing details
        </h2>
        <p className="mt-1 text-[0.875rem] leading-relaxed text-cloud-400">
          Used for your invoice and to open the order with the payment provider.
        </p>

        <div className="mt-5 flex flex-col gap-5">
          <Input
            id={`${formId}-name`}
            label="Full legal name"
            hint="As it should appear on your invoice."
            autoComplete="name"
            value={values.name}
            error={fieldError("name")}
            disabled={busy}
            onChange={(v) => update("name", v)}
            onBlur={() => blur("name")}
          />

          <div>
            <Input
              id={`${formId}-email`}
              label="Billing email"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              value={values.email}
              error={fieldError("email")}
              disabled={busy}
              onChange={(v) => update("email", v)}
              onBlur={() => blur("email")}
              hint={
                differentEmail
                  ? `Receipts and invoices go here. You still log in with ${accountEmail}.`
                  : "Receipts and invoices go here. This is also your login email."
              }
            />
          </div>

          <fieldset>
            <legend className="text-[0.875rem] font-medium text-cloud-50">Phone number</legend>
            <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
              <label htmlFor={`${formId}-country`} className="sr-only">
                Country code
              </label>
              <select
                id={`${formId}-country`}
                value={values.country}
                disabled={busy}
                autoComplete="tel-country-code"
                onChange={(e) => update("country", e.target.value)}
                onBlur={() => blur("country")}
                aria-invalid={Boolean(fieldError("country"))}
                className={cn(
                  "h-11 w-full min-w-0 rounded-xl border bg-white px-3 text-[0.9375rem] text-cloud-50 disabled:bg-ink-900",
                  fieldError("country") ? "border-rose-400" : "border-ink-700",
                )}
              >
                {countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name} ({country.dial})
                  </option>
                ))}
              </select>
              <label htmlFor={`${formId}-phone`} className="sr-only">
                Phone number
              </label>
              <div className="relative">
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[0.9375rem] text-cloud-400"
                >
                  {dial}
                </span>
                <input
                  id={`${formId}-phone`}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={values.phone}
                  disabled={busy}
                  onChange={(e) => update("phone", e.target.value)}
                  onBlur={() => blur("phone")}
                  aria-invalid={Boolean(fieldError("phone"))}
                  aria-describedby={`${formId}-phone-help`}
                  className={cn(
                    "h-11 w-full rounded-xl border bg-white pr-3 text-[0.9375rem] text-cloud-50 placeholder:text-cloud-500 disabled:bg-ink-900",
                    dial.length > 3 ? "pl-14" : "pl-12",
                    fieldError("phone") || fieldError("country") ? "border-rose-400" : "border-ink-700",
                  )}
                  placeholder="Mobile number"
                />
              </div>
            </div>
            <p
              id={`${formId}-phone-help`}
              className={cn("mt-1.5 text-[0.8125rem]", fieldError("phone") || fieldError("country") ? "text-rose-400" : "text-cloud-400")}
            >
              {fieldError("phone") ?? fieldError("country") ?? "Some payment providers need a contact number to open an order."}
            </p>
          </fieldset>
        </div>

        <div className="mt-6 flex gap-3 rounded-xl bg-ink-900 px-4 py-3 text-[0.8125rem] leading-relaxed text-cloud-300">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden />
          <p>
            We never ask for your card number, UPI PIN or bank password. You enter those only on the
            payment provider&apos;s own secure page.
          </p>
        </div>
      </section>

      {/* ── Summary, payment method, pay ────────────────────────── */}
      <div className="flex flex-col gap-6">
        {summary}

        <section aria-labelledby={`${formId}-method`} className="rounded-xl border border-ink-700 bg-white p-5 sm:p-6">
          <h2 id={`${formId}-method`} className="text-[1.0625rem] font-semibold text-cloud-50">
            Payment method
          </h2>

          {options.length === 0 || !chosen ? (
            <div role="status" className="mt-4 flex gap-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden />
              <div className="text-[0.9375rem] leading-relaxed">
                <p className="font-semibold text-cloud-50">
                  Checkout is temporarily unavailable
                </p>
                <p className="mt-1 text-cloud-300">
                  None of our payment methods can take payments in {plan.currency} right now, so this purchase can&apos;t be completed. Please try again later.{" "}
                  You haven&apos;t been charged and your current plan is unchanged.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label="Payment provider" className="mt-4 flex flex-col gap-2.5">
                {options.map((option) => {
                  const selected = option.id === chosen.id;
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        "flex cursor-pointer gap-3 rounded-xl border p-3.5 transition-colors",
                        selected ? "border-azure-500 bg-azure-500/[0.05] ring-1 ring-azure-500" : "border-ink-700 hover:border-zinc-300",
                        busy && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <input
                        type="radio"
                        name="gateway"
                        value={option.id}
                        checked={selected}
                        disabled={busy}
                        onChange={() => setGatewayId(option.id)}
                        className="mt-1 size-4 shrink-0 accent-[var(--color-azure-500)]"
                      />
                      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-ink-700 bg-white">
                        {LOGOS[option.id] ? (
                          <Image src={LOGOS[option.id]} alt="" width={32} height={32} className="size-8 object-contain" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-[0.9375rem] font-semibold text-cloud-50">{option.label}</span>
                          <span
                            className={cn(
                              "rounded-md px-1.5 py-0.5 text-[0.75rem] font-medium",
                              option.simulated || option.environment === "sandbox"
                                ? "bg-amber-400/[0.1] text-amber-400"
                                : "bg-mint-400/[0.1] text-mint-400",
                            )}
                          >
                            {option.simulated ? "Test mode" : option.environment === "sandbox" ? "Sandbox" : "Available"}
                          </span>
                        </span>
                        <span className="mt-1 block text-[0.8125rem] leading-snug text-cloud-400">
                          {option.methods.join(" · ")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <p className="mt-3 text-[0.8125rem] leading-relaxed text-cloud-400">
                {chosen.simulated
                  ? "Test mode: the payment is simulated locally. No money moves."
                  : chosen.environment === "sandbox"
                    ? `${chosen.label} is in sandbox mode, so this is a test order, not a real payment.`
                    : `${chosen.blurb} Your plan activates only after ${chosen.label} confirms the payment to our server.`}
              </p>

              <div
                ref={errorSummary}
                tabIndex={-1}
                id={`${formId}-status`}
                aria-live="polite"
                className="outline-none"
              >
                {status.kind === "error" ? (
                  <p role="alert" className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/[0.05] px-4 py-3 text-[0.875rem] text-rose-400">
                    {status.message}
                  </p>
                ) : status.kind === "cancelled" ? (
                  <p className="mt-4 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-[0.875rem] text-cloud-200">
                    Payment cancelled. Nothing was charged — you can try again whenever you&apos;re ready.
                  </p>
                ) : status.kind === "with-gateway" ? (
                  <p className="mt-4 text-[0.875rem] text-cloud-300">
                    Complete the payment in the {chosen.label} window.
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                disabled={busy}
                aria-busy={busy}
                className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-azure-500 px-5 text-[1rem] font-semibold text-white shadow-[0_1px_2px_rgba(24,24,27,0.12)] transition-colors hover:bg-azure-600 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {busy ? (
                  <>
                    <Spinner />
                    {status.kind === "verifying" ? "Confirming payment" : status.kind === "with-gateway" ? `Waiting for ${chosen.label}` : "Opening secure payment"}
                  </>
                ) : (
                  <>
                    <LockKeyhole className="size-4" aria-hidden />
                    Pay {plan.priceLabel} with {chosen.label}
                  </>
                )}
              </button>

              {!chosen.simulated ? (
                <p className="mt-3 text-center text-[0.75rem] leading-relaxed text-cloud-400">
                  You&apos;ll finish the payment securely with {chosen.label}.
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </form>
  );
}

function Input({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  onBlur,
  ...rest
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "onBlur" | "value" | "id">) {
  return (
    <div>
      <label htmlFor={id} className="text-[0.875rem] font-medium text-cloud-50">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-help`}
        className={cn(
          "mt-1.5 h-11 w-full rounded-xl border bg-white px-3.5 text-[0.9375rem] text-cloud-50 placeholder:text-cloud-500 disabled:bg-ink-900",
          error ? "border-rose-400" : "border-ink-700",
        )}
        {...rest}
      />
      <p id={`${id}-help`} className={cn("mt-1.5 text-[0.8125rem]", error ? "text-rose-400" : "text-cloud-400")}>
        {error ?? hint}
      </p>
    </div>
  );
}
