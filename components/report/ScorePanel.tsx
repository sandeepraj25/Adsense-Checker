import {
  Check,
  CircleAlert,
  FileText,
  Gauge,
  Info,
  Navigation,
  ShieldCheck,
  Smartphone,
  Wrench,
} from "lucide-react";

import { ScoreArc } from "@/components/ui/ScoreArc";
import { DemoBadge, VerdictBadge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import type { CategoryScore, Report } from "@/lib/db/types";

const verdictCopy: Record<Report["verdict"], string> = {
  ready:
    "Nothing here would obviously block an application. Fix the remaining warnings if you want the margin, then apply.",

  needs_improvement:
    "The foundation is there, but a reviewer would find something to object to. Clear the blockers first, then re-check.",

  not_ready:
    "There is enough missing here that an application would very likely be rejected. Work through the high-priority items below.",
};

/* ── score panel ─────────────────────────────────────────────── */

export function ScorePanel({ report }: { report: Report }) {
  return (
    <div className="glass edge-light relative overflow-hidden rounded-xl p-5 sm:p-7">
      <div className="flex flex-col items-start gap-7 sm:flex-row sm:items-center sm:gap-9">
        <ScoreArc value={report.score} size={176} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <VerdictBadge verdict={report.verdict} />

            {report.analysisMode === "demo" ? <DemoBadge /> : null}
          </div>

          <h2 className="t-h3 mt-4 text-cloud-50">
            {report.domain}
          </h2>

          <p className="mt-2.5 max-w-lg text-[0.9375rem] leading-relaxed text-cloud-400">
            {verdictCopy[report.verdict]}
          </p>

          <div className="mt-5 flex flex-wrap gap-x-7 gap-y-3">
            <Tally
              label="Passed"
              value={report.passedCount}
              tone="pass"
            />

            <Tally
              label="To fix"
              value={report.warningCount}
              tone="warn"
            />

            <Tally
              label="Blockers"
              value={report.criticalCount}
              tone="fail"
            />
          </div>
        </div>
      </div>

      {report.analysisMode === "demo" ? (
        <p className="mt-6 rounded-xl border border-azure-500/25 bg-azure-500/[0.07] px-4 py-3 text-[0.875rem] leading-relaxed text-cloud-200">
          <span className="font-medium text-cloud-50">
            This report is seeded demo data.
          </span>{" "}
          The site could not be reached from this server, so the figures below
          were generated deterministically from the domain name to demonstrate
          the report. They are not an observation of your website, and they are
          not a Google decision.
        </p>
      ) : null}
    </div>
  );
}

/* ── tally ───────────────────────────────────────────────────── */

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "pass" | "warn" | "fail";
}) {
  const toneClass = {
    pass: "text-mint-400",
    warn: "text-amber-400",
    fail: "text-rose-400",
  }[tone];

  return (
    <div>
      <p
        className={cn(
          "t-display text-[1.5rem] leading-none",
          toneClass,
        )}
      >
        {value}
      </p>

      <p className="t-eyebrow mt-1.5 text-[0.75rem] text-cloud-600">
        {label}
      </p>
    </div>
  );
}

/* ── category styling ────────────────────────────────────────── */

function categoryStyle(id: string) {
  switch (id) {
    case "content":
    case "content_quality":
      return {
        icon: FileText,
        iconClass:
          "border-azure-500/60 bg-azure-500/[0.06] text-azure-600",
        bar: "bg-azure-500",
      };

    case "seo":
      return {
        icon: Gauge,
        iconClass:
          "border-orange-400/60 bg-orange-500/[0.06] text-orange-400",
        bar: "bg-orange-400",
      };

    case "navigation":
      return {
        icon: Navigation,
        iconClass:
          "border-mint-400/60 bg-mint-500/[0.06] text-mint-400",
        bar: "bg-mint-400",
      };

    case "mobile":
    case "mobile_experience":
      return {
        icon: Smartphone,
        iconClass:
          "border-amber-400/60 bg-amber-500/[0.06] text-amber-400",
        bar: "bg-amber-400",
      };

    case "privacy":
    case "privacy_legal":
    case "privacy_and_legal":
      return {
        icon: ShieldCheck,
        iconClass:
          "border-cyan-400/60 bg-cyan-500/[0.06] text-cyan-400",
        bar: "bg-cyan-400",
      };

    case "technical":
    case "technical_health":
      return {
        icon: Wrench,
        iconClass:
          "border-azure-500/60 bg-azure-500/[0.06] text-azure-600",
        bar: "bg-azure-500",
      };

    default:
      return {
        icon: FileText,
        iconClass:
          "border-azure-500/60 bg-azure-500/[0.06] text-azure-600",
        bar: "bg-azure-500",
      };
  }
}

/* ── category status ─────────────────────────────────────────── */

/** Status comes from the score alone, so colour always means the same thing. */
function getStatus(score: number) {
  if (score >= 85) {
    return { label: "Excellent", tone: "text-mint-400", bar: "bg-mint-400", icon: Check };
  }
  if (score >= 70) {
    return { label: "Good", tone: "text-azure-600", bar: "bg-azure-500", icon: Check };
  }
  return { label: "Needs work", tone: "text-amber-400", bar: "bg-amber-400", icon: CircleAlert };
}

/* ── category breakdown ──────────────────────────────────────── */

export function CategoryBreakdown({
  categories,
}: {
  categories: CategoryScore[];
}) {
  return (
    <section className="glass w-full rounded-xl p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[1.25rem] font-semibold tracking-tight text-cloud-50">Category scores</h2>
          <p className="mt-1 text-[0.875rem] text-cloud-400">
            How each area of the site scored in this run.
          </p>
        </div>
        <Info className="mt-1 size-4 shrink-0 text-cloud-400" aria-hidden />
      </div>

      <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => {
          const style = categoryStyle(category.id);
          const status = getStatus(category.score);
          const Icon = style.icon;
          const StatusIcon = status.icon;

          return (
            <li key={category.id} className="rounded-lg border border-ink-700 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-900 text-cloud-300">
                    <Icon className="size-4" strokeWidth={1.8} aria-hidden />
                  </span>
                  <h3 className="truncate text-[0.9375rem] font-semibold text-cloud-50">{category.name}</h3>
                </span>
                <p className="t-data text-[1.5rem] font-semibold leading-none text-cloud-50">
                  {category.score}
                  <span className="sr-only"> out of 100</span>
                </p>
              </div>

              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-850" aria-hidden>
                <span
                  className={cn("block h-full rounded-full", status.bar)}
                  style={{ width: `${Math.max(category.score, 2)}%` }}
                />
              </div>

              <p className={cn("mt-2.5 flex items-center gap-1.5 text-[0.8125rem] font-medium", status.tone)}>
                <StatusIcon className="size-3.5" strokeWidth={2.2} aria-hidden />
                {status.label}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
