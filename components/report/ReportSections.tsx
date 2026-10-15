import Link from "next/link";

import { LockKeyhole, Crown, ArrowRight } from "lucide-react";



import { Badge } from "@/components/ui/Badge";

import { cn } from "@/lib/cn";

import { cheapestPlanWith, listActivePlans } from "@/lib/plan-catalogue";

import { FEATURE_META, type FeatureKey } from "@/lib/plans";

import { sitePriceLabel } from "@/lib/site-currency";

import type {

  PageScore,

  PolicyRisk,

  Recommendation,

  ReportMetrics,

} from "@/lib/db/types";



/* ── measured signals ─────────────────────────────────────────────── */



const AI_BAND_LABEL: Record<"low" | "moderate" | "elevated", string> = {

  low: "Reads as human-written",

  moderate: "Mixed signals",

  elevated: "Reads as machine-written",

};



const RISK_LABEL: Record<

  "low" | "moderate" | "elevated" | "high",

  string

> = {

  low: "Low",

  moderate: "Moderate",

  elevated: "Elevated",

  high: "High",

};



export function SignalGrid({ metrics }: { metrics: ReportMetrics }) {

  const cells: { label: string; value: string; hint?: string }[] = [];



  if (metrics.totalWords !== undefined) {

    cells.push({

      label: "Words read",

      value: metrics.totalWords.toLocaleString("en-IN"),

      hint:

        metrics.averageWords !== undefined

          ? `${metrics.averageWords.toLocaleString(

              "en-IN",

            )} words per page on average`

          : undefined,

    });

  }



  if (metrics.aiLikelihood !== undefined) {

    cells.push({

      label: "AI-written estimate",

      value: `${metrics.aiLikelihood}%`,

      hint: `${

        metrics.aiBand ? `${AI_BAND_LABEL[metrics.aiBand]} · ` : ""

      }${

        metrics.aiReliable === false

          ? "Too little text to be reliable"

          : "A signal, not a determination"

      }`,

    });

  }



  if (metrics.humanSignalScore !== undefined) {

    cells.push({

      label: "Human authorship signals",

      value: `${metrics.humanSignalScore}%`,

      hint: "Bylines, dates, first-person voice and editorial structure",

    });

  }



  if (metrics.originality !== undefined) {

    cells.push({

      label: "Originality signal",

      value: `${metrics.originality}%`,

      hint: "Boilerplate and stock phrasing measured on your own text",

    });

  }



  if (metrics.duplicatePairs !== undefined) {

    cells.push({

      label: "Duplicate pages",

      value: String(metrics.duplicatePairs),

      hint:

        metrics.duplicateShare !== undefined

          ? `${metrics.duplicateShare}% of read pages overlap heavily`

          : "Pairs of pages that overlap heavily",

    });

  }



  if (metrics.adDensity !== undefined) {

    cells.push({

      label: "Ad density",

      value: `${metrics.adDensity}%`,

      hint:

        metrics.adSlots !== undefined

          ? `${metrics.adSlots} ad slot${

              metrics.adSlots === 1 ? "" : "s"

            } found`

          : undefined,

    });

  }



  if (metrics.sitemapUrls !== undefined) {

    cells.push({

      label: "Sitemap URLs",

      value: metrics.sitemapUrls.toLocaleString("en-IN"),

      hint: "Parsed from your sitemap",

    });

  }



  if (metrics.maxDepth !== undefined) {

    cells.push({

      label: "Structure depth",

      value: String(metrics.maxDepth),

      hint:

        metrics.averageDepth !== undefined

          ? `${metrics.averageDepth} average · ${

              metrics.orphanPages ?? 0

            } orphan page(s)`

          : undefined,

    });

  }



  if (metrics.brokenLinks !== undefined) {

    cells.push({

      label: "Broken internal links",

      value: String(metrics.brokenLinks),

      hint: "Links we followed that did not resolve",

    });

  }



  if (metrics.riskLevel !== undefined) {

    cells.push({

      label: "Policy risk",

      value: RISK_LABEL[metrics.riskLevel],

      hint: "Our reading of the findings, not Google's assessment",

    });

  }



  if (cells.length === 0) return null;



  return (

    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">

      {cells.map((cell) => (

        <div

          key={cell.label}

          className={cn(

            "glass rounded-xl border border-ink-700 p-5",

            "transition-all duration-300",

            "hover:border-ink-700",

            "hover:bg-ink-800",

          )}

        >

          <p className="text-[0.875rem] font-medium text-cloud-200">

            {cell.label}

          </p>



          <p className="t-display mt-3 text-[1.85rem] leading-none text-cloud-50">

            {cell.value}

          </p>



          {cell.hint ? (

            <p className="mt-3 text-[0.875rem] leading-relaxed text-cloud-400">

              {cell.hint}

            </p>

          ) : null}

        </div>

      ))}

    </div>

  );

}



/* ── page-by-page ─────────────────────────────────────────────────── */



function scoreTone(score: number): string {

  if (score >= 85) return "text-mint-400";

  if (score >= 60) return "text-amber-400";

  return "text-rose-400";

}



export function PageTable({ pages }: { pages: PageScore[] }) {

  return (

    <div className="glass overflow-hidden rounded-xl border border-ink-700">

      <div className="overflow-x-auto">

        <table className="w-full min-w-[46rem] border-collapse text-left">

          <thead>

            <tr className="border-b border-ink-700 bg-ink-900">

              <Th>Page</Th>

              <Th align="right">Status</Th>

              <Th align="right">Words</Th>

              <Th align="right">AI est.</Th>

              <Th align="right">Findings</Th>

              <Th align="right">Score</Th>

            </tr>

          </thead>



          <tbody>

            {pages.map((page) => (

              <tr

                key={page.url}

                className={cn(

                  "border-b border-ink-700 last:border-0",

                  "transition-colors duration-200 hover:bg-ink-800",

                )}

              >

                <td className="px-5 py-4">

                  <a

                    href={page.url}

                    target="_blank"

                    rel="noreferrer nofollow noopener"

                    className="block max-w-[20rem] truncate text-[0.9375rem] font-medium text-cloud-50 underline decoration-cloud-600 underline-offset-4 transition-colors hover:text-cloud-50"

                  >

                    {page.path || "/"}

                  </a>



                  {page.title ? (

                    <p className="mt-1.5 max-w-[20rem] truncate text-[0.8125rem] text-cloud-400">

                      {page.title}

                    </p>

                  ) : null}

                </td>



                <Td>{page.status}</Td>



                <Td>{page.words.toLocaleString("en-IN")}</Td>



                <Td>

                  {page.aiLikelihood === null

                    ? "—"

                    : `${page.aiLikelihood}%`}

                </Td>



                <Td>{page.issues}</Td>



                <td className="px-5 py-4 text-right">

                  <span

                    className={cn(

                      "t-display text-[1.125rem]",

                      scoreTone(page.score),

                    )}

                  >

                    {page.score}

                  </span>

                </td>

              </tr>

            ))}

          </tbody>

        </table>

      </div>

    </div>

  );

}



function Th({

  children,

  align = "left",

}: {

  children: React.ReactNode;

  align?: "left" | "right";

}) {

  return (

    <th

      className={cn(

        "px-5 py-4 text-[0.75rem] font-semibold tracking-[0.14em] text-cloud-300",

        align === "right" && "text-right",

      )}

    >

      {children}

    </th>

  );

}



function Td({ children }: { children: React.ReactNode }) {

  return (

    <td className="px-5 py-4 text-right text-[0.9375rem] font-medium text-cloud-100">

      {children}

    </td>

  );

}



/* ── remediation plan ─────────────────────────────────────────────── */



const priorityTone: Record<

  Recommendation["priority"],

  "fail" | "warn" | "neutral"

> = {

  high: "fail",

  medium: "warn",

  low: "neutral",

};



export function RecommendationList({

  items,

}: {

  items: Recommendation[];

}) {

  return (

    <ol className="flex flex-col gap-4">

      {items.map((item) => (

        <li

          key={item.rank}

          className={cn(

            "glass group relative overflow-hidden rounded-xl",

            "border border-ink-700 p-5",

            "transition-all duration-300",

            "hover:border-ink-700 hover:bg-ink-800",

          )}

        >

          <div className="flex gap-4">

            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-ink-700 bg-ink-900">

              <span className="t-data text-[0.875rem] font-medium text-cloud-200">

                {String(item.rank).padStart(2, "0")}

              </span>

            </div>



            <div className="min-w-0 flex-1">

              <div className="flex flex-wrap items-center gap-3">

                <h3 className="text-[1rem] font-semibold text-cloud-50 sm:text-[1.0625rem]">

                  {item.title}

                </h3>



                <Badge

                  tone={

                    (priorityTone[item.priority] ?? "neutral") as

                      | "fail"

                      | "warn"

                      | "neutral"

                  }

                >

                  {item.priority}

                </Badge>

              </div>



              <p className="mt-3 max-w-3xl text-[0.9375rem] leading-relaxed text-cloud-200">

                {item.action}

              </p>

            </div>

          </div>

        </li>

      ))}

    </ol>

  );

}



/* ── policy risk ──────────────────────────────────────────────────── */



const riskTone: Record<

  PolicyRisk["level"],

  "fail" | "warn" | "neutral"

> = {

  high: "fail",

  moderate: "warn",

  low: "neutral",

};



export function RiskList({ risks }: { risks: PolicyRisk[] }) {

  return (

    <ul className="flex flex-col gap-4">

      {risks.map((risk) => (

        <li

          key={risk.label}

          className={cn(

            "glass rounded-xl border border-ink-700 p-5",

            "transition-all duration-300",

            "hover:border-ink-700 hover:bg-ink-800",

          )}

        >

          <div className="flex flex-wrap items-center justify-between gap-3">

            <h3 className="text-[1rem] font-semibold text-cloud-50 sm:text-[1.0625rem]">

              {risk.label}

            </h3>



            <Badge tone={riskTone[risk.level]}>

              {risk.level} risk

            </Badge>

          </div>



          <p className="mt-3 max-w-3xl text-[0.9375rem] leading-relaxed text-cloud-200">

            {risk.why}

          </p>

        </li>

      ))}

    </ul>

  );

}



/* ── modern locked feature cards ──────────────────────────────────── */

type LockedPlanGroup = {
  planName: string;
  price: string | null;
  features: FeatureKey[];
};

const LOCKED_COLORS = [
  "border-blue-200 bg-gradient-to-br from-blue-50 to-white text-blue-600",
  "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white text-emerald-600",
  "border-orange-200 bg-gradient-to-br from-orange-50 to-white text-orange-600",
  "border-pink-200 bg-gradient-to-br from-pink-50 to-white text-pink-600",
  "border-violet-200 bg-gradient-to-br from-violet-50 to-white text-violet-600",
  "border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-600",
];

function FeatureIllustration({ label }: { label: string }) {
  const value = label.toLowerCase();

  // Purpose-built inline SVG artwork (not generic icon-font glyphs).
  // Each illustration uses the same 64×64 canvas so the cards stay consistent.
  if (value.includes("duplicate")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M12 8h24l8 8v29H12z" fill="#fff" stroke="#E11D48" strokeWidth="3" strokeLinejoin="round" />
        <path d="M36 8v9h8M18 25h18M18 32h13" stroke="#E11D48" strokeWidth="3" strokeLinecap="round" />
        <path d="M27 25h24l6 6v23H27z" fill="#FDA4AF" stroke="#BE123C" strokeWidth="3" strokeLinejoin="round" />
        <path d="M51 25v7h6M33 39h17M33 46h12" stroke="#BE123C" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }

  if (value.includes("originality")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M12 7h25l9 9v27H12z" fill="#fff" stroke="#F97316" strokeWidth="3" strokeLinejoin="round" />
        <path d="M37 7v10h9M18 25h20M18 32h15M18 39h11" stroke="#F97316" strokeWidth="3" strokeLinecap="round" />
        <path d="M44 34l13 5v9c0 6-5 10-13 13-8-3-13-7-13-13v-9z" fill="#F97316" stroke="#EA580C" strokeWidth="2" strokeLinejoin="round" />
        <path d="M39 47l4 4 7-8" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (value.includes("policy") || value.includes("risk")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M32 5l23 8v17c0 13-9 22-23 29C18 52 9 43 9 30V13z" fill={value.includes("risk") ? "#16A34A" : "#6D28D9"} />
        {value.includes("risk") ? <path d="M32 18v17M32 43v1" stroke="#fff" strokeWidth="5" strokeLinecap="round" /> : <text x="32" y="40" fontSize="27" fontWeight="800" fill="#fff" textAnchor="middle">G</text>}
      </svg>
    );
  }

  if (value.includes("human")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M12 7h25l9 9v35H12z" fill="#fff" stroke="#16A34A" strokeWidth="3" strokeLinejoin="round" />
        <path d="M37 7v10h9M18 26h20M18 33h14M18 40h10" stroke="#16A34A" strokeWidth="3" strokeLinecap="round" />
        <circle cx="48" cy="45" r="12" fill="#16A34A" />
        <circle cx="48" cy="42" r="3.5" fill="#fff" />
        <path d="M41 51c1-5 13-5 14 0" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (value.includes("robot")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M32 8v7" stroke="#B77900" strokeWidth="3" strokeLinecap="round" />
        <circle cx="32" cy="6" r="3" fill="#F59E0B" />
        <rect x="10" y="16" width="44" height="34" rx="9" fill="#FDE68A" stroke="#B77900" strokeWidth="3" />
        <rect x="17" y="24" width="30" height="15" rx="5" fill="#fff" />
        <circle cx="25" cy="31" r="3" fill="#B77900" /><circle cx="39" cy="31" r="3" fill="#B77900" />
        <path d="M24 44h16M5 27v13M59 27v13" stroke="#B77900" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }

  if (value.includes("structure")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M32 17v12M14 29h36M14 29v9M32 29v9M50 29v9" stroke="#EA580C" strokeWidth="3" strokeLinecap="round" />
        <rect x="23" y="5" width="18" height="15" rx="3" fill="#FDBA74" stroke="#EA580C" strokeWidth="3" />
        <rect x="5" y="38" width="18" height="17" rx="3" fill="#fff" stroke="#EA580C" strokeWidth="3" />
        <rect x="23" y="38" width="18" height="17" rx="3" fill="#fff" stroke="#EA580C" strokeWidth="3" />
        <rect x="41" y="38" width="18" height="17" rx="3" fill="#fff" stroke="#EA580C" strokeWidth="3" />
      </svg>
    );
  }

  if (value.includes("sitemap")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <rect x="24" y="5" width="16" height="13" rx="3" fill="#DBEAFE" stroke="#2563EB" strokeWidth="3" />
        <path d="M32 18v10M13 28h38M13 28v8M32 28v8M51 28v8" stroke="#2563EB" strokeWidth="3" strokeLinecap="round" />
        <rect x="5" y="36" width="16" height="14" rx="2" fill="#fff" stroke="#2563EB" strokeWidth="3" />
        <rect x="24" y="36" width="16" height="14" rx="2" fill="#fff" stroke="#2563EB" strokeWidth="3" />
        <rect x="43" y="36" width="16" height="14" rx="2" fill="#fff" stroke="#2563EB" strokeWidth="3" />
      </svg>
    );
  }

  if (value.includes("robots")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M13 6h26l10 10v41H13z" fill="#fff" stroke="#B77900" strokeWidth="3" strokeLinejoin="round" />
        <path d="M39 6v11h10M19 25h23M19 32h16" stroke="#B77900" strokeWidth="3" strokeLinecap="round" />
        <rect x="28" y="37" width="30" height="20" rx="4" fill="#B77900" />
        <text x="43" y="51" fontSize="10" fontWeight="800" fill="#fff" textAnchor="middle">TXT</text>
      </svg>
    );
  }

  if (value.includes("density")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <rect x="7" y="10" width="50" height="44" rx="7" fill="#6D28D9" />
        <rect x="14" y="17" width="36" height="30" rx="3" fill="#fff" />
        <text x="32" y="37" fontSize="17" fontWeight="900" fill="#6D28D9" textAnchor="middle">AD</text>
      </svg>
    );
  }

  if (value.includes("recommendation")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M22 40c0-5-7-8-7-17a17 17 0 0134 0c0 9-7 12-7 17z" fill="#FBCFE8" stroke="#DB2777" strokeWidth="3" strokeLinejoin="round" />
        <path d="M24 45h16M25 50h14M28 55h8" stroke="#DB2777" strokeWidth="3" strokeLinecap="round" />
        <path d="M32 1v5M5 18l5 2M59 18l-5 2M10 4l4 4M54 4l-4 4" stroke="#DB2777" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }

  if (value.includes("page-by-page")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M10 7h27l9 9v41H10z" fill="#fff" stroke="#2563EB" strokeWidth="3" strokeLinejoin="round" />
        <path d="M37 7v10h9M16 25h19" stroke="#2563EB" strokeWidth="3" strokeLinecap="round" />
        <rect x="17" y="39" width="5" height="11" rx="1" fill="#93C5FD" /><rect x="27" y="33" width="5" height="17" rx="1" fill="#60A5FA" /><rect x="37" y="27" width="5" height="23" rx="1" fill="#2563EB" />
      </svg>
    );
  }

  if (value.includes("crawl") || value.includes("indexability")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <circle cx="32" cy="32" r="23" fill="#FCE7F3" stroke="#DB2777" strokeWidth="3" />
        <path d="M9 32h46M32 9c8 7 12 15 12 23S40 48 32 55M32 9c-8 7-12 15-12 23s4 16 12 23" stroke="#DB2777" strokeWidth="2.5" />
        <path d="M15 17l5 3M49 17l-5 3" stroke="#DB2777" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }

  if (value.includes("deep ai") || value.includes("ai content") || value.includes("ai +")) {
    return (
      <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
        <path d="M12 7h25l9 9v36H12z" fill="#fff" stroke={value.includes("deep") ? "#6D28D9" : "#16A34A"} strokeWidth="3" strokeLinejoin="round" />
        <path d="M37 7v10h9M18 26h20M18 33h15M18 40h10" stroke={value.includes("deep") ? "#6D28D9" : "#16A34A"} strokeWidth="3" strokeLinecap="round" />
        <rect x="32" y="35" width="28" height="22" rx="5" fill={value.includes("deep") ? "#6D28D9" : "#16A34A"} />
        <text x="46" y="50" fontSize="12" fontWeight="800" fill="#fff" textAnchor="middle">AI</text>
      </svg>
    );
  }

  // Advanced page check and the fallback use a custom browser/search illustration.
  return (
    <svg viewBox="0 0 64 64" className="h-12 w-12" fill="none" aria-hidden="true">
      <rect x="7" y="10" width="43" height="34" rx="5" fill="#2563EB" />
      <path d="M7 18h43" stroke="#fff" strokeWidth="3" />
      <circle cx="14" cy="14" r="1.5" fill="#fff" /><circle cx="20" cy="14" r="1.5" fill="#fff" /><circle cx="26" cy="14" r="1.5" fill="#fff" />
      <rect x="12" y="24" width="15" height="4" rx="2" fill="#BFDBFE" />
      <circle cx="39" cy="39" r="10" fill="#fff" stroke="#2563EB" strokeWidth="4" />
      <path d="M46 46l9 9" stroke="#2563EB" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

export function LockedFeatures({ locked }: { locked: FeatureKey[] }) {
  if (locked.length === 0) return null;

  const groups = new Map<string, LockedPlanGroup>();

  // Keep the existing plan catalogue as the source of truth.
  for (const feature of locked) {
    const plan = cheapestPlanWith(feature);
    if (!plan) continue;

    const entry: LockedPlanGroup = groups.get(plan.id) ?? {
      planName: plan.name,
      price: sitePriceLabel(plan),
      features: [],
    };

    entry.features.push(feature);
    groups.set(plan.id, entry);
  }

  if (groups.size === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {[...groups.entries()].map(([planId, group]) => {
        const isBasic = group.planName.toLowerCase() === "basic";

        return (
          <section
            key={planId}
            className={cn(
              "overflow-hidden rounded-2xl border p-4 shadow-sm sm:p-5 lg:p-6",
              isBasic
                ? "border-blue-200 bg-gradient-to-br from-blue-50/80 via-white to-blue-50/40"
                : "border-violet-200 bg-gradient-to-br from-violet-50/80 via-white to-purple-50/40",
            )}
          >
            <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={cn(
                    "min-w-24 rounded-xl px-5 py-2 text-center text-lg font-bold",
                    isBasic
                      ? "bg-blue-100 text-blue-700"
                      : "bg-violet-100 text-violet-700",
                  )}
                >
                  {group.planName}
                </span>

                <h3 className="text-base font-bold tracking-tight text-slate-950 sm:text-xl">
                  Available on {group.planName} · {group.features.length}{" "}
                  {group.features.length === 1 ? "check" : "checks"} didn&apos;t run in this scan
                </h3>
              </div>

              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold",
                  isBasic
                    ? "bg-blue-100 text-blue-700"
                    : "bg-violet-100 text-violet-700",
                )}
              >
                <LockKeyhole size={15} aria-hidden="true" />
                {group.features.length} checks locked
              </span>
            </header>

            <div
              className={cn(
                isBasic &&
                  "grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-stretch",
              )}
            >
              <div
                className={cn(
                  "grid grid-cols-1 gap-3 sm:grid-cols-2",
                  isBasic ? "xl:grid-cols-3" : "xl:grid-cols-5",
                )}
              >
                {group.features.map((feature: FeatureKey, index: number) => {
                  const meta = FEATURE_META[feature];
                  const color = LOCKED_COLORS[index % LOCKED_COLORS.length];

                  return (
                    <article
                      key={feature}
                      className={cn(
                        "relative flex min-h-[155px] flex-col items-center justify-center rounded-xl border p-4 text-center",
                        "transition duration-200 hover:-translate-y-0.5 hover:shadow-md",
                        color,
                      )}
                    >
                      <span className="absolute right-3 top-3 grid size-7 place-items-center rounded-full border border-white/80 bg-white/85 text-slate-700">
                        <LockKeyhole size={14} aria-hidden="true" />
                      </span>

                      <div className="mb-3 grid size-[76px] place-items-center rounded-full bg-white/75">
                        <FeatureIllustration label={meta.label} />
                      </div>

                      <h4 className="max-w-[190px] text-sm font-bold leading-snug text-slate-950">
                        {meta.label}
                      </h4>
                      <p className="mt-1 text-xs text-slate-600">Available on {group.planName}</p>
                    </article>
                  );
                })}
              </div>

              {isBasic && (
                <UpgradeCard
                  planName={group.planName}
                  price={group.price}
                  compact
                />
              )}
            </div>

            {!isBasic && (
              <div className="mt-5">
                <UpgradeCard planName={group.planName} price={group.price} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function UpgradeCard({
  planName,
  price,
  compact = false,
}: {
  planName: string;
  price: string | null;
  compact?: boolean;
}) {
  const isBasic = planName.toLowerCase() === "basic";

  return (
    <div
      className={cn(
        "flex flex-col justify-center rounded-2xl p-5 sm:p-6",
        isBasic
          ? "bg-gradient-to-br from-blue-50 to-blue-100/80"
          : "bg-gradient-to-br from-violet-50 to-purple-100/80",
        !compact && "gap-3 sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      <div className={cn(!compact && "flex min-w-0 items-center gap-4")}>
        <div
          className={cn(
            "mb-4 grid size-14 shrink-0 place-items-center rounded-full",
            !compact && "sm:mb-0",
            isBasic
              ? "bg-blue-100 text-blue-600"
              : "bg-violet-100 text-violet-700",
          )}
        >
          <Crown size={30} aria-hidden="true" />
        </div>

        <div>
          <h4 className="text-xl font-bold tracking-tight text-slate-950">
            Upgrade to {planName}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Re-run this scan to unlock these checks. Your existing reports will
            remain unchanged.
          </p>
          {price && (
            <p className="mt-2 text-xs text-slate-500">{price}/month</p>
          )}
        </div>
      </div>

      <Link
        href="/pricing"
        className={cn(
          "mt-5 inline-flex min-h-12 w-full shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-3",
          "text-sm font-semibold text-white shadow-sm transition hover:brightness-110",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          isBasic
            ? "bg-blue-600 focus-visible:ring-blue-500"
            : "bg-violet-700 focus-visible:ring-violet-500",
          !compact && "sm:mt-0 sm:w-auto sm:min-w-56",
        )}
      >
        Upgrade to {planName}
        <ArrowRight size={18} aria-hidden="true" />
      </Link>
    </div>
  );
}

/**
 * The one honest "more found" number a smaller plan can show: content
 * pages the scan saw linked but did not read (its page allowance ran out).
 * It comes from links already read, so no locked check runs to produce it.
 * Shown only when some active plan reads more pages per scan.
 */
export function UnreadPagesTeaser({ unread, pageLimit }: { unread: number | undefined; pageLimit: number | null }) {
  if (!unread || unread < 1 || !pageLimit) return null;
  const bigger = listActivePlans()
    .filter((plan) => plan.pagesPerScan > pageLimit)
    .sort((a, b) => a.amountPaise - b.amountPaise)[0];
  if (!bigger) return null;
  return (
    <div className="no-print glass flex flex-col gap-3 rounded-xl border border-azure-400/20 bg-azure-400/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[0.9375rem] leading-snug text-cloud-200">
        We found at least <span className="t-data font-semibold text-cloud-50">{unread}</span> more{" "}
        {unread === 1 ? "page" : "pages"} on your site that this scan didn&apos;t read — it reads up to {pageLimit}{" "}
        {pageLimit === 1 ? "page" : "pages"}. {bigger.name} reads up to {bigger.pagesPerScan} per scan.
      </p>
      <Link
        href="/pricing"
        className="inline-flex shrink-0 items-center gap-1.5 text-[0.875rem] font-semibold text-azure-600 hover:underline"
      >
        See {bigger.name}
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </div>
  );
}
