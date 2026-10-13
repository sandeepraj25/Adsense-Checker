import type { Metadata } from "next";
import Link from "next/link";
import { Globe } from "lucide-react";

import { PlanGrid, planSignupHref } from "@/components/pricing/PlanGrid";
import { Navbar } from "@/components/sections/Navbar";
import { Footer } from "@/components/sections/Footer";
import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";
import { ToastProvider } from "@/components/ui/Toast";
import { optionalUser } from "@/lib/auth/guard";
import {
  expireStaleSubscriptions,
  getActiveSubscription,
} from "@/lib/db/billing";
import { normalizeDomain } from "@/lib/domain";
import { checkoutOptions, checkoutOptionsFor } from "@/lib/payments";
import { siteCurrency } from "@/lib/site-currency";
import { listActivePlans } from "@/lib/plan-catalogue";
import type { PlanId } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Three monthly plans. Every allowance resets each billing month, and you can change or cancel your plan whenever you like.",
};

export const dynamic = "force-dynamic";

const faqs = [
  {
    q: "Is AdSense Eligibility Checker an official Google service?",
    a: "No. AdSense Eligibility Checker is an independent pre-review tool designed to help you identify potential AdSense approval issues before applying. Final approval is always decided by Google.",
  },
  {
    q: "What counts as one scan?",
    a: "Each website analysis counts as one scan. You can run another scan after making changes to check whether your issues have been resolved.",
  },
  {
    q: "Do unused scans carry forward?",
    a: "No. Your scan allowance resets with each billing cycle, and unused scans do not carry forward to the next month.",
  },
  {
    q: "Can I change or upgrade my plan?",
    a: "Yes. You can upgrade your plan whenever you need more scans or additional checks. Your new plan features become available after payment is verified.",
  },
  {
    q: "Does AdSense Eligibility Checker guarantee AdSense approval?",
    a: "No. AdSense Eligibility Checker helps you identify potential issues and improve your website before applying, but the final AdSense approval decision is always made by Google.",
  },
];

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; plan?: string }>;
}) {
  const { url, plan: selectedPlan } = await searchParams;
  // One currency for the whole site, chosen by an administrator. There is
  // no switcher; a `currency` left in an old link is ignored.
  const currency = siteCurrency();
  const carryUrl = normalizeDomain(url ?? "") ?? undefined;

  const user = await optionalUser();

  if (user) {
    expireStaleSubscriptions();
  }

  const subscription = user ? getActiveSubscription(user.id) : null;

  const plans = listActivePlans();
  const anyGateway = checkoutOptions().length > 0;
  const options = checkoutOptionsFor(currency);

  const signupHref = (planId: string) => planSignupHref({ planId, plans, carryUrl });

  const selectedPlanId = plans.some((plan) => plan.id === selectedPlan)
    ? (selectedPlan as PlanId)
    : null;

  return (
    <ToastProvider>
      <Navbar
        viewer={
          user && !user.isBlocked
            ? { name: user.name, email: user.email, avatarUrl: user.avatarUrl, isAdmin: user.isAdmin }
            : null
        }
      />

      <main>
        {/* ── Header ───────────────────────────────────────────── */}
        <section className="relative overflow-hidden pt-28 pb-10 sm:pt-32">
          <div
            aria-hidden
            className="app-glow pointer-events-none absolute inset-0 -top-32"
          />

          <div
            aria-hidden
            className="dot-field pointer-events-none absolute inset-0 opacity-40"
          />

          <Container size="wide" className="relative">
            <h1 className="t-h1 text-center text-cloud-50">
              Monthly Plans.
            </h1>


            {carryUrl ? (
              <div className="mx-auto mt-8 flex max-w-xl items-center justify-center gap-2.5 rounded-xl border border-azure-400/20 bg-azure-400/[0.06] px-4 py-3">
                <Globe
                  className="size-4 shrink-0 text-azure-600"
                  aria-hidden
                />

                <p className="text-[0.9375rem] text-cloud-200">
                  Pick a plan and we will scan{" "}
                  <span className="t-data text-cloud-50">{carryUrl}</span>{" "}
                  straight after.
                </p>
              </div>
            ) : null}
          </Container>
        </section>

        {/* ── Plans ────────────────────────────────────────────── */}
        <section className="pb-20">
          <Container size="default">
            {user && selectedPlanId ? (
              <p className="mb-5 text-center text-[0.9375rem] text-cloud-400">
                You&apos;re ready to continue with your selected plan below.
              </p>
            ) : null}
            {user && !anyGateway ? (
              <p
                role="status"
                className="mx-auto mb-6 max-w-xl rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-center text-[0.9375rem] leading-relaxed text-cloud-200"
              >
                Online payment is not switched on yet, so upgrades are
                paused. You are still signed in and your current plan is
                unchanged.
              </p>
            ) : null}
            <PlanGrid
              plans={plans}
              user={user}
              subscription={subscription}
              currency={currency}
              options={options}
              carryUrl={carryUrl}
              selectedPlanId={selectedPlanId}
            />
          </Container>
        </section>

        {/* ── Questions ────────────────────────────────────────── */}
        <section className="border-t border-ink-700 py-20">
          <Container>
            <div>
              <p className="text-[0.875rem] font-semibold tracking-[0.18em] text-cloud-500">
                Before you buy
              </p>

              <h2 className="t-h2 mt-3 text-cloud-50">
                The honest answers
              </h2>
            </div>

            <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {faqs.map((faq) => (
                <Reveal key={faq.q}>
                  <h3 className="t-h3 text-cloud-50">{faq.q}</h3>

                  <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-cloud-400">
                    {faq.a}
                  </p>
                </Reveal>
              ))}
            </div>

            <p className="mt-12 text-[0.9375rem] text-cloud-600">
              Still deciding?{" "}
              <Link
                href={user ? "/dashboard/checker" : signupHref("free")}
                className="text-cloud-200 underline decoration-cloud-600 underline-offset-4 transition-colors hover:text-cloud-50"
              >
                Run the free scan first
              </Link>{" "}
              — same engine, fewer checks.
            </p>
          </Container>
        </section>
      </main>

      <Footer />
    </ToastProvider>
  );
}
