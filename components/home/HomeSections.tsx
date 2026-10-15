'use client';

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  AlertTriangle,
  ChartNoAxesColumnIncreasing,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Compass,
  Download,
  FileSearch,
  FileText,
  Flame,
  Gauge,
  Globe,
  Lightbulb,
  ListChecks,
  RefreshCcw,
  Scale,
  Search,
  ShieldCheck,
  Smartphone,
  Wrench,
  X,
  XCircle,
} from "lucide-react";

import { AnalyticsChoicesButton } from "@/components/analytics/Tracker";
import { PlanGrid } from "@/components/pricing/PlanGrid";
import { CycleSwitcher } from "@/components/pricing/CycleSwitcher";
import { yearlyOffer } from "@/lib/billing/offer";
import { Container } from "@/components/ui/Container";
import { UrlForm } from "@/components/ui/UrlForm";
import PlatformMarquee from "@/components/home/PlatformMarquee";
import { TOTAL_CHECKS } from "@/lib/analysis/checks";
import { cn } from "@/lib/cn";
import type { Subscription, User } from "@/lib/db/types";
import type { Currency } from "@/lib/money";
import type { CheckoutOption } from "@/lib/payments";
import type { PlanRecord } from "@/lib/plan-catalogue";
import type { FeatureKey } from "@/lib/plans";
import AdSenseLogo from "@/Image/Google-Adsense-Logo.png";
import { ARTICLES, STATIC_FAQS } from "./content";
import { OpenFromHash } from "./OpenFromHash";

/**
 * The homepage sections, top to bottom: hero, platform marquee, key features,
 * report showcase, report, process, live approval results, pricing, and FAQ.
 */

function SectionHeading({ id, title, lede, className }: { id: string; title: string; lede?: string; className?: string }) {
  return (
    <div className={cn("max-w-2xl", className)}>
      <h2 id={id} className="t-display t-h2 text-cloud-50">
        {title}
      </h2>
      {lede ? <p className="mt-4 text-[1.0625rem] leading-relaxed text-cloud-300">{lede}</p> : null}
    </div>
  );
}

/* ── hero ───────────────────────────────────────────────────────── */

export function HomeHero({ viewer }: { viewer: { name: string } | null }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden pb-16 pt-32 sm:pb-24 sm:pt-36">
      <div aria-hidden className="app-glow pointer-events-none absolute inset-x-0 -top-40 h-[34rem] opacity-70" />
      <Container size="wide" className="relative">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
          <div>
            <p className="inline-flex items-center gap-2 text-[0.875rem] font-medium text-cloud-300">
              <Image src={AdSenseLogo} alt="Google AdSense" width={350} height={100} className="h-6 w-auto" priority />
            </p>

            <h1 id="hero-title" className="t-display t-h1 mt-4 max-w-xl text-balance text-cloud-50">
              Is your website ready for AdSense?
            </h1>

            <p className="mt-5 max-w-lg text-[1.0625rem] leading-relaxed text-cloud-300">
              Rejected by AdSense? We’ll help you fix the issues and get your website ready for approval.
            </p>

            <div className="mt-8 max-w-[34rem]">
              <UrlForm />
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-ink-700 bg-white shadow-[0_24px_60px_-36px_rgba(24,24,27,0.4)]">
            <Image
              src="/video/approval/Home-page-hero.png"
              alt="AdSenseChecker dashboard showing Website Readiness Score and AdSense Approval Score"
              width={1536}
              height={1024}
              priority
              className="block h-auto w-full object-contain"
            />
          </div>
        </div>
      </Container>
    </section>
  );
}

/* ── platform trust marquee ─────────────────────────────────────── */

export function HomePlatformTrust() {
  return <PlatformMarquee />;
}

/* ── key features ────────────────────────────────────────────────── */

export function HomeFeatures({
  freeFeatures: _freeFeatures,
}: {
  freeFeatures: readonly FeatureKey[];
}) {
  const features = [
    {
      title: "Content Quality Analysis",
      description:
        "Checks your content quality, uniqueness and value for users.",
      icon: Search,
      color: "bg-indigo-50 text-indigo-600",
    },
    {
      title: "Essential Pages Check",
      description:
        "Verifies About, Contact, Privacy Policy and other important pages.",
      icon: FileText,
      color: "bg-emerald-50 text-emerald-600",
    },
    {
      title: "SEO & Indexing",
      description:
        "Analyzes meta tags, indexing status, sitemap and crawlability.",
      icon: Compass,
      color: "bg-indigo-50 text-indigo-600",
    },
    {
      title: "Technical Audit",
      description:
        "Checks HTTPS, page speed, mobile usability and technical issues.",
      icon: Gauge,
      color: "bg-blue-50 text-blue-600",
    },
    {
      title: "AdSense Policy Compliance",
      description:
        "Identifies potential policy issues and restricted content.",
      icon: ShieldCheck,
      color: "bg-orange-50 text-orange-600",
    },
    {
      title: "Actionable Recommendations",
      description:
        "Get clear steps to fix issues and improve your readiness.",
      icon: Lightbulb,
      color: "bg-amber-50 text-amber-600",
    },
  ];

  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="overflow-hidden border-t border-gray-100 bg-slate-50 px-4 py-12 sm:px-6 sm:py-16 lg:px-8 lg:py-20"
    >
      <div className="mx-auto max-w-7xl">
        {/* Section heading */}
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue-600 sm:text-xs sm:tracking-[0.18em]">
            Key Features
          </p>

          <h2
            id="features-title"
            className="mt-3 text-2xl font-bold leading-tight tracking-tight text-slate-900 sm:text-3xl md:text-4xl"
          >
            Everything You Need to Check
            <span className="mt-1 block">
              Your AdSense Readiness
            </span>
          </h2>

          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:mt-4 sm:text-base sm:leading-7">
            Our website analysis checks important factors and gives you clear,
            actionable recommendations.
          </p>
        </div>

        {/* Responsive feature cards */}
        <div className="mt-8 grid grid-cols-2 gap-3 sm:mt-10 sm:gap-4 lg:grid-cols-3 lg:gap-5">
          {features.map((feature) => {
            const Icon = feature.icon;

            return (
              <article
                key={feature.title}
                className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm transition-shadow duration-200 hover:shadow-md sm:gap-4 sm:p-5 lg:gap-5 lg:p-6"
              >
                <div
                  className={`flex size-11 shrink-0 items-center justify-center rounded-xl sm:size-12 lg:size-14 lg:rounded-2xl ${feature.color}`}
                >
                  <Icon
                    className="size-5 sm:size-6 lg:size-7"
                    aria-hidden="true"
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold leading-5 text-slate-900 sm:text-base sm:leading-6">
                    {feature.title}
                  </h3>

                  <p className="mt-1.5 text-[13px] leading-5 text-slate-600 sm:mt-2 sm:text-sm sm:leading-6">
                    {feature.description}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ── report showcase ────────────────────────────────────────────── */

export function HomeReportShowcase() {
  const benefits = [
    {
      icon: Flame,
      title: "Overall readiness score",
      color: "bg-orange-50 text-orange-500",
    },
    {
      icon: ChartNoAxesColumnIncreasing,
      title: "Category-wise analysis",
      color: "bg-indigo-50 text-indigo-600",
    },
    {
      icon: FileSearch,
      title: "Detailed issue breakdown",
      color: "bg-blue-50 text-blue-600",
    },
    {
      icon: ShieldCheck,
      title: "Practical recommendations",
      color: "bg-emerald-50 text-emerald-600",
    },
    {
      icon: Download,
      title: "Download and share reports",
      color: "bg-rose-50 text-rose-500",
    },
  ];

  return (
    <section
      id="sample-report"
      aria-labelledby="sample-report-title"
      className="border-t border-slate-100 bg-white px-5 py-16 sm:px-8 sm:py-24"
    >
      <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.85fr)] lg:gap-10">
        {/* Report preview */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_60px_-30px_rgba(37,99,235,0.25)]">
          <Image
            src="/images/website-analysis-report.png"
            alt="Example AdSenseChecker website analysis report showing readiness score, category scores, issues and recommendations"
            width={1334}
            height={620}
            className="block h-auto w-full"
            sizes="(max-width: 1024px) 100vw, 65vw"
          />
        </div>

        {/* Report details */}
        <div>
          <span className="inline-flex items-center rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold uppercase tracking-wider text-indigo-600">
            Sample Report
          </span>

          <h2
            id="sample-report-title"
            className="mt-5 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl"
          >
            See Exactly What Needs Improvement
          </h2>

          <p className="mt-4 text-base leading-7 text-slate-600">
            Get a detailed analysis report with clear insights, identified
            issues and step-by-step recommendations to improve your website
            readiness.
          </p>

          <ul className="mt-7 space-y-5">
            {benefits.map((benefit) => {
              const Icon = benefit.icon;

              return (
                <li key={benefit.title} className="flex items-center gap-4">
                  <span
                    className={`flex size-11 shrink-0 items-center justify-center rounded-full ${benefit.color}`}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                  </span>

                  <span className="text-base font-medium text-slate-700">
                    {benefit.title}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ── the report ─────────────────────────────────────────────────── */

export function HomeReport() {
  const reportBenefits = [
    {
      icon: Gauge,
      title: "Overall readiness score",
      color: "bg-orange-50 text-orange-500",
    },
    {
      icon: ListChecks,
      title: "Category-wise analysis",
      color: "bg-indigo-50 text-indigo-600",
    },
    {
      icon: FileText,
      title: "Detailed issue breakdown",
      color: "bg-blue-50 text-blue-600",
    },
    {
      icon: ShieldCheck,
      title: "Practical recommendations",
      color: "bg-emerald-50 text-emerald-600",
    },
    {
      icon: Download,
      title: "Download and share reports",
      color: "bg-rose-50 text-rose-500",
    },
  ];

  return (
    <section
      id="report"
      aria-labelledby="report-title"
      className="scroll-mt-8 border-t border-ink-700 bg-white py-16 sm:py-24"
    >
      <Container size="wide">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,0.85fr)] lg:gap-12">
          {/* Report preview image */}
          <figure className="min-w-0">
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_-32px_rgba(37,99,235,0.25)]">
              <Image
                src="/images/website-analysis-report.png"
                alt="AdSenseChecker website analysis report dashboard"
                width={1792}
                height={832}
                className="block h-auto w-full"
                sizes="(max-width: 1024px) 100vw, 65vw"
              />
            </div>
          </figure>

          {/* Report benefits */}
          <div>
            <h2
              id="report-title"
              className="mt-5 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl"
            >
              Needs Improvement
            </h2>

            <p className="mt-4 text-base leading-7 text-slate-600">
              Get a clear report showing what’s wrong with your website and how to fix it for AdSense approval.
            </p>

            <ul className="mt-7 space-y-5">
              {reportBenefits.map((benefit) => {
                const Icon = benefit.icon;

                return (
                  <li key={benefit.title} className="flex items-center gap-4">
                    <span
                      className={`flex size-11 shrink-0 items-center justify-center rounded-full ${benefit.color}`}
                    >
                      <Icon className="size-5" aria-hidden="true" />
                    </span>

                    <span className="text-base font-medium text-slate-700">
                      {benefit.title}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </Container>
    </section>
  );
}

/* ── how it works ───────────────────────────────────────────────── */

export function HomeProcess() {
  const steps = [
    {
      number: "1",
      icon: Globe,
      pngSrc: "/images/step-url.png",
      title: "Enter Your Website URL",
      description:
        "Enter your domain to get started with your website analysis.",
      color: "bg-blue-50 text-blue-600",
    },
    {
      number: "2",
      icon: Search,
      pngSrc: "/images/step-ai.png",
      title: "AI Analyzes Your Website",
      description:
        "Our AI-powered analysis checks 50+ factors affecting your AdSense readiness.",
      color: "bg-indigo-50 text-indigo-600",
    },
    {
      number: "3",
      icon: FileText,
      pngSrc: "/images/step-report.png",
      title: "Get Your Detailed Report",
      description:
        "See your readiness score, identify issues and get clear steps to fix them.",
      color: "bg-emerald-50 text-emerald-600",
    },
  ];

  return (
    <section
      id="process"
      aria-labelledby="process-title"
      className="scroll-mt-8 overflow-hidden border-t border-slate-100 bg-gradient-to-b from-slate-50/50 to-white px-3 py-12 sm:px-6 sm:py-16 lg:px-8 lg:py-24"
    >
      <div className="mx-auto max-w-7xl">
        {/* Section Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-blue-600 ring-1 ring-inset ring-blue-500/20 sm:text-xs sm:tracking-[0.18em]">
            How It Works
          </p>

          <h2
            id="process-title"
            className="mt-4 text-2xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-3xl lg:text-4xl"
          >
            Get Your AdSense Report in 3 Simple Steps
          </h2>

          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:mt-4 sm:text-base sm:leading-7">
            Find out what needs fixing and how to improve your website before
            applying for AdSense.
          </p>
        </div>

        {/* Three Responsive Cards */}
        <div className="relative mt-8 grid grid-cols-3 gap-2 sm:mt-12 sm:gap-5 lg:mt-16 lg:gap-8">
          {/* Connector Line */}
          <div
            aria-hidden="true"
            className="absolute left-[15%] right-[15%] top-5 hidden border-t-2 border-dashed border-blue-200/80 sm:block lg:top-6"
          />

          {steps.map((step) => {
            const Icon = step.icon;

            return (
              <article
                key={step.number}
                className="group relative flex min-w-0 flex-col items-center rounded-xl border border-slate-100 bg-white p-2 text-center shadow-sm transition-all duration-300 hover:border-blue-200 hover:shadow-md sm:rounded-2xl sm:p-5 lg:p-6"
              >
                {/* Step Number */}
                <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white shadow-md shadow-blue-500/30 transition-transform duration-300 group-hover:scale-110 sm:size-9 sm:text-sm lg:size-10">
                  {step.number}
                </span>

                {/* Icon */}
                <div
                  className={`mt-3 flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-slate-100/80 transition-transform duration-300 group-hover:scale-105 sm:mt-6 sm:size-16 sm:rounded-2xl lg:size-20 ${step.color}`}
                >
                  <Icon
                    className="size-4 sm:size-6 lg:size-8"
                    aria-hidden="true"
                  />
                </div>

                {/* Title */}
                <h3 className="mt-3 text-[10px] font-bold leading-tight text-slate-900 transition-colors duration-200 group-hover:text-blue-600 sm:mt-5 sm:text-base sm:leading-6 lg:text-lg">
                  {step.title}
                </h3>

                {/* Description */}
                <p className="mt-1 text-[9px] leading-snug text-slate-600 sm:mt-2 sm:max-w-sm sm:text-xs sm:leading-relaxed lg:text-sm">
                  {step.description}
                </p>
              </article>
            );
          })}
        </div>

        {/* AI Highlight Tag */}
        <div className="mt-8 flex justify-center sm:mt-12">
          <div className="inline-flex max-w-full items-center justify-center gap-2 rounded-full border border-blue-100 bg-blue-50/80 px-3 py-2 text-center text-[10px] font-medium text-blue-700 shadow-sm backdrop-blur-sm sm:px-4 sm:text-sm">
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-blue-500" />
            </span>
            AI-powered website analysis · 50+ checks
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── live approval results ──────────────────────────────────────── */

export function LiveApprovalResults() {
  const results = [
    {
      domain: "Approved Website #1",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense1.jpeg",
    },
    {
      domain: "Approved Website #2",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense2.png",
    },
    {
      domain: "Approved Website #3",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense3.webp",
    },
    {
      domain: "Approved Website #4",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense4.webp",
    },
    {
      domain: "Approved Website #5",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense5.png",
    },
    {
      domain: "Approved Website #6",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense6.jpg",
    },
    {
      domain: "Approved Website #7",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense7.jpg",
    },
    {
      domain: "Approved Website #8",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense8.jpeg",
    },
    {
      domain: "Approved Website #9",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense9.png",
    },
    {
      domain: "Approved Website #10",
      label: "AdSense Approved",
      description: "Verified approval result",
      image: "/video/approval/adsense10.PNG",
    },
  ];

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const closePreview = () => setSelectedIndex(null);

  const showPrevious = () => {
    setSelectedIndex((current) =>
      current === null
        ? null
        : (current - 1 + results.length) % results.length
    );
  };

  const showNext = () => {
    setSelectedIndex((current) =>
      current === null ? null : (current + 1) % results.length
    );
  };

  return (
    <section
      id="approval-results"
      aria-labelledby="approval-results-title"
      className="overflow-hidden border-t border-slate-100 bg-slate-50 px-4 py-12 sm:px-6 sm:py-16 lg:px-8 lg:py-24"
    >
      <div className="mx-auto max-w-7xl">
        {/* Heading */}
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 sm:text-xs">
            <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
            Approval Results
          </span>

          <h2
            id="approval-results-title"
            className="mt-4 text-2xl font-bold leading-tight tracking-tight text-slate-900 sm:text-3xl lg:text-4xl"
          >
            Real Websites. Real Approval Results.
          </h2>

          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:mt-4 sm:text-base sm:leading-7">
            Explore AdSense approval evidence shared by website owners.
          </p>
        </div>

        {/* Gallery */}
        <div className="mt-8 grid grid-cols-2 gap-3 sm:mt-10 sm:gap-5 lg:grid-cols-3 lg:gap-6">
          {results.map((result, index) => (
            <article
              key={result.image}
              className="group min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg sm:rounded-2xl"
            >
              {/* Clickable image */}
              <button
                type="button"
                onClick={() => setSelectedIndex(index)}
                aria-label={`View ${result.domain} approval image`}
                className="relative block aspect-[4/3] w-full cursor-zoom-in overflow-hidden bg-slate-100 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
              >
                <Image
                  src={result.image}
                  alt={`AdSense approval evidence ${index + 1}`}
                  width={640}
                  height={480}
                  sizes="(max-width: 639px) 50vw, (max-width: 1023px) 50vw, 33vw"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                />

                <div className="absolute inset-0 flex items-end bg-gradient-to-t from-slate-950/45 via-transparent to-transparent opacity-70 transition-opacity group-hover:opacity-100">
                  <span className="p-2 text-[10px] font-medium text-white sm:p-4 sm:text-xs">
                    Tap to enlarge
                  </span>
                </div>
              </button>

              {/* Compact card details */}
              <div className="p-3 sm:p-4 lg:p-5">
                <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold text-emerald-700 sm:gap-2 sm:text-sm">
                  <CheckCircle2 className="size-4 shrink-0 sm:size-5" />
                  <span className="truncate">{result.label}</span>
                </div>

                <h3 className="mt-2 break-words text-xs font-semibold leading-snug text-slate-900 sm:text-base">
                  {result.domain}
                </h3>

                <p className="mt-1 text-[10px] leading-4 text-slate-500 sm:text-sm sm:leading-5">
                  {result.description}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>

      {/* Full-size image preview */}
      {selectedIndex !== null && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 p-3 backdrop-blur-sm sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Approval image preview"
          onClick={closePreview}
        >
          <button
            type="button"
            onClick={closePreview}
            aria-label="Close image preview"
            className="absolute right-3 top-3 z-10 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 sm:right-6 sm:top-6"
          >
            <X className="size-6" />
          </button>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              showPrevious();
            }}
            aria-label="Previous image"
            className="absolute left-2 z-10 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 sm:left-5 sm:size-11"
          >
            <ChevronLeft className="size-6" />
          </button>

          <div
            className="flex max-h-[85vh] w-full max-w-5xl flex-col items-center"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="relative h-[65vh] w-full sm:h-[75vh]">
              <Image
                src={results[selectedIndex].image}
                alt={`AdSense approval evidence ${selectedIndex + 1}`}
                fill
                sizes="100vw"
                className="object-contain"
                priority
              />
            </div>

            <p className="mt-3 text-center text-sm font-medium text-white">
              {results[selectedIndex].domain} · {selectedIndex + 1} of{" "}
              {results.length}
            </p>
          </div>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              showNext();
            }}
            aria-label="Next image"
            className="absolute right-2 z-10 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 sm:right-5 sm:size-11"
          >
            <ChevronRight className="size-6" />
          </button>
        </div>
      )}
    </section>
  );
}

/* ── pricing ────────────────────────────────────────────────────── */

export function HomePricing({
  plans,
  user,
  subscription,
  currency,
  options,
  anyGateway,
  yearlyOn = false,
}: {
  plans: PlanRecord[];
  user: User | null;
  subscription: Subscription | null;
  currency: Currency;
  options: CheckoutOption[];
  anyGateway: boolean;
  /** The site-wide yearly switch, read on the server by the page. */
  yearlyOn?: boolean;
}) {
  const yearlyDiscounts = plans.map((plan) => yearlyOffer(plan, currency, yearlyOn)).filter((o) => o !== null).map((o) => o.discount ?? 0);
  const grid = (cycle: "monthly" | "yearly") => (
    <PlanGrid
      plans={plans}
      user={user}
      subscription={subscription}
      currency={currency}
      options={options}
      selectedPlanId={null}
      cycle={cycle}
      yearlyOn={yearlyOn}
    />
  );
  return (
    <section
      aria-labelledby="pricing-title"
      id="pricing"
      className="scroll-mt-8 border-t border-ink-700 bg-slate-50/50 py-16 sm:py-24"
    >
      <Container size="wide">
        {/* Centered heading */}
        <div className="mx-auto max-w-3xl text-center">
          <h2
            id="pricing-title"
            className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl lg:text-5xl"
          >
            Choose the Right Plan for You
          </h2>

          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Start with a free scan and upgrade whenever you need more scans
            or deeper website analysis.
          </p>
        </div>

        {user && !anyGateway ? (
          <p
            role="status"
            className="mx-auto mt-8 max-w-xl rounded-xl border border-amber-400/25 bg-amber-50 px-4 py-3 text-center text-sm leading-relaxed text-amber-800"
          >
            Online payments are currently unavailable, so plan upgrades are
            paused. Your current plan remains unchanged.
          </p>
        ) : null}

        {/* Pricing plans */}
        <div className="mt-10 sm:mt-14">
          {yearlyDiscounts.length > 0 ? (
            <CycleSwitcher
              monthly={grid("monthly")}
              yearly={grid("yearly")}
              bestDiscount={Math.max(...yearlyDiscounts) || null}
            />
          ) : (
            grid("monthly")
          )}
        </div>

        {/* Additional pricing details */}
        <div className="mt-8 text-center">
          <p className="text-sm text-slate-500">
            Need more details about plan limits and features?
          </p>

          <Link
            href="/pricing"
            className="mt-2 inline-flex items-center font-semibold text-azure-600 transition-colors hover:text-azure-500"
          >
            Compare all plans
            <span aria-hidden="true" className="ml-1">
              →
            </span>
          </Link>
        </div>
      </Container>
    </section>
  );
}

/* ── questions ──────────────────────────────────────────────────── */

export function HomeFaq({
  paymentMethods: _paymentMethods,
}: {
  paymentMethods: string[];
}) {
  const faqs: { q: string; a: React.ReactNode }[] = [
    {
      q: "Is AdSense Checker an official Google service?",
      a: "No. AdSense Checker is an independent website analysis tool. It is not affiliated with, endorsed by, or operated by Google.",
    },
    {
      q: "Does a high score guarantee AdSense approval?",
      a: "Our machine learning model analyzes your website’s content, articles, and key eligibility factors using patterns learned from a large number of websites to help you identify issues and maximize your chances of getting Google AdSense approval.",
    },
    {
      q: "Is this platform free to use?",
      a: "Yes! Our free plan lets you analyze your website and check its AdSense readiness.",
    },
    {
      q: "What does a website scan check?",
      a: `Our deep website analysis runs 50+ checks covering content quality, article depth, originality, SEO structure, policy compliance, indexing, page performance, and technical health to identify issues affecting your AdSense readiness. Available checks vary by plan.`,
    },
    {
      q: "Why was my website rejected by AdSense?",
      a: "Common issues can include thin or low-value content, missing essential pages, navigation problems and potential policy violations. The report helps you identify issues that may need attention.",
    },
    {
      q: "How many scans are included in the free plan?",
      a: "The number of scans and available checks depends on your plan. Please review the pricing section for the current limits.",
    },
    {
      q: "Can I upgrade or change my plan later?",
      a: "Yes. You can review the available plans and choose an upgrade when you need additional scans or more comprehensive checks.",
    },
    {
      q: "How do I pay for a plan?",
      a: (
        <ul>
          <li>
            <strong>Indian users:</strong> Pay using UPI, debit/credit cards, and other available payment methods.
          </li>
          <li>
            <strong>International users:</strong> Pay using PayPal or debit/credit cards.
          </li>
          <li>
            If you face any payment issues, contact our support team for assistance.
          </li>
        </ul>
      ),
    },
    {
      q: "How can I contact the support team?",
      a: (
        <>
          You can email us at{" "}
          <a
            href="mailto:helps@adsenseeligibilitychecker.com"
            className="font-semibold text-primary hover:underline"
          >
            helps@adsenseeligibilitychecker.com
          </a>{" "}
          or use the live chat support available in the bottom-right corner of our website.
        </>
      ),
    },
  ];

  return (
    <section
      aria-labelledby="faq-title"
      id="faq"
      className="scroll-mt-8 border-t border-ink-700 py-16 sm:py-24"
    >
      <Container size="default">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-azure-600">
            FAQs
          </p>

          <h2
            id="faq-title"
            className="mt-3 text-3xl font-bold tracking-tight text-cloud-50 sm:text-4xl"
          >
            Frequently Asked Questions
          </h2>

          <p className="mt-4 text-base leading-7 text-cloud-300">
            Have questions about website scans, reports or pricing? Find the
            answers below.
          </p>
        </div>

        <div className="mx-auto mt-10 max-w-3xl divide-y divide-ink-700 border-y border-ink-700">
          {faqs.map((faq) => (
            <details key={faq.q} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 [&::-webkit-details-marker]:hidden">
                <span className="text-[1.0625rem] font-semibold text-cloud-50">
                  {faq.q}
                </span>

                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-full border border-ink-700 text-cloud-300 transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>

              <div className="max-w-3xl pb-6 text-[0.9375rem] leading-relaxed text-cloud-300">
                {faq.a}
              </div>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}