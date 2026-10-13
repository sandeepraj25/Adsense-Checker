import Link from "next/link";
import { ChevronRight, Clock3 } from "lucide-react";

import { Badge, DemoBadge, VerdictBadge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import type { Report } from "@/lib/db/types";
import { formatAge, formatDuration } from "@/lib/format";

/** Verdict colours from the design tokens: success / warning / error. */
const scoreTone: Record<string, string> = {
  ready: "var(--color-mint-400)",
  needs_improvement: "var(--color-amber-400)",
  not_ready: "var(--color-rose-400)",
};

/** A compact score ring. The number carries the meaning; the ring is a cue. */
function ScoreRing({ score, color }: { score: number; color: string }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 48 48" className="size-12 shrink-0 -rotate-90" aria-hidden>
      <circle cx="24" cy="24" r={r} fill="none" stroke="var(--color-ink-700)" strokeWidth="4" />
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${(score / 100) * c} ${c}`}
      />
    </svg>
  );
}

export function ReportRow({
  report,
  now,
  className,
}: {
  report: Report;
  now: number;
  className?: string;
}) {
  const running = report.state === "running";
  const failed = report.state === "failed";
  const score = Math.max(0, Math.min(100, report.score ?? 0));
  const scoreColor = scoreTone[report.verdict] ?? "var(--color-azure-500)";

  return (
    <Link
      href={`/dashboard/reports/${report.id}`}
      className={cn(
        "group flex flex-col gap-4 rounded-xl border border-ink-700 bg-white p-4 transition-colors",
        "hover:border-zinc-300 hover:bg-ink-900",
        "sm:flex-row sm:items-center sm:gap-5 sm:px-5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {/* Score */}
        <div className="relative grid size-12 shrink-0 place-items-center">
          {running || failed ? (
            <span className="grid size-12 place-items-center rounded-full border-4 border-ink-700 text-[0.875rem] font-semibold text-cloud-400">
              —
            </span>
          ) : (
            <>
              <ScoreRing score={score} color={scoreColor} />
              <span className="t-data absolute text-[0.9375rem] font-semibold text-cloud-50">
                {report.score}
              </span>
            </>
          )}
        </div>
        <span className="sr-only">
          {running || failed ? "No score" : `Score ${report.score} out of 100`}
        </span>

        {/* Domain + counts */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[1rem] font-semibold text-cloud-50">{report.domain}</h3>
            {report.analysisMode === "demo" ? <DemoBadge /> : null}
          </div>

          {!running && !failed ? (
            <p className="t-data mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-cloud-400">
              <span>
                <span className="font-semibold text-mint-400">{report.passedCount}</span> passed
              </span>
              <span>
                <span className="font-semibold text-amber-400">{report.warningCount}</span> to fix
              </span>
              <span>
                <span className="font-semibold text-rose-400">{report.criticalCount}</span>{" "}
                {report.criticalCount === 1 ? "blocker" : "blockers"}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-[0.8125rem] text-cloud-400">
              {running ? "Running now…" : (report.errorMessage ?? "The run did not finish")}
            </p>
          )}
        </div>
      </div>

      {/* Status + time */}
      <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
        <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
          {running ? (
            <Badge tone="brand" dot>
              Running
            </Badge>
          ) : failed ? (
            <Badge tone="fail">Failed</Badge>
          ) : (
            <VerdictBadge verdict={report.verdict} />
          )}
          <span className="t-data inline-flex items-center gap-1.5 text-[0.8125rem] text-cloud-400">
            <Clock3 className="size-3.5" aria-hidden />
            {formatAge(report.startedAt, now)}
            {report.durationMs ? ` · ${formatDuration(report.durationMs)}` : ""}
          </span>
        </div>
        <ChevronRight
          className="size-5 shrink-0 text-cloud-400 transition-colors group-hover:text-cloud-50"
          aria-hidden
        />
      </div>
    </Link>
  );
}
