import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Cpu,
  FileText,
  RotateCw,
  ScanSearch,
} from "lucide-react";

import { CategoryBreakdown, ScorePanel } from "@/components/report/ScorePanel";
import { IssueList } from "@/components/report/IssueList";
import { ReportActions } from "@/components/report/ReportActions";
import {
  LockedFeatures,
  PageTable,
  RecommendationList,
  RiskList,
  SignalGrid,
  UnreadPagesTeaser,
} from "@/components/report/ReportSections";
import { RunningPanel } from "@/components/report/RunningPanel";
import { AreaSummary, SmartInsights } from "@/components/report/Areas";
import { countByArea, splitInsights } from "@/lib/report/areas";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { requireUser } from "@/lib/auth/guard";
import { findReportForUser, listIssues } from "@/lib/db/audits";
import { formatDate, formatDateTime, formatDuration, plural } from "@/lib/format";
import { canSchedule, getSchedule } from "@/lib/schedules/store";
import { WeeklyRescanToggle } from "@/components/report/WeeklyRescanToggle";
import { cheapestPlanWith } from "@/lib/plan-catalogue";

export const metadata: Metadata = {
  title: "Report",
};

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await requireUser();

  const report = findReportForUser(id, user.id);

  if (!report) {
    notFound();
  }

  const issues =
    report.state === "complete"
      ? listIssues(report.id)
      : [];

  const canExport = report.features.includes("pdf_export");

  // Smart insights get their own section; the findings are everything else.
  const { findings, insights } = splitInsights(issues);
  const areaCounts = countByArea(issues);

  const exportPlan = canExport
    ? null
    : cheapestPlanWith("pdf_export");

  const metrics = report.metrics;

  // Weekly rescans (feature 53): shown to accounts whose plan includes
  // them, and to anyone with a schedule so it can always be turned off.
  const schedule = getSchedule(user.id, report.domain);
  const showRescans =
    report.state === "complete" &&
    report.analysisMode === "live" &&
    (canSchedule(user.id).ok || Boolean(schedule?.enabled));
  const rescanNote = !schedule?.enabled
    ? null
    : schedule.state === "paused"
      ? schedule.stateReason
      : `Next scan around ${formatDate(schedule.nextRunAt)}`;

  const recommendations =
    metrics.recommendations ?? [];

  const risks =
    metrics.risks ?? [];

  const hasSignals = Object.keys(metrics).some(
    (key) =>
      key !== "recommendations" &&
      key !== "unreadPages" &&
      key !== "risks",
  );

  return (
    <div
      className={`font-[var(--font-sans)] flex flex-col gap-8${canExport ? "" : " report-print-locked"}`}
    >
      {/* What a printout shows when this report's plan has no PDF export:
          the same access rule as the button, so Ctrl+P is no way round it. */}
      {canExport ? null : (
        <div className="print-only-notice hidden">
          <p className="text-lg font-semibold">PDF export is not included in the {report.planName} plan.</p>
          <p className="mt-2">
            {exportPlan ? `It is available on ${exportPlan.name}. ` : ""}This report can be read online at
            your dashboard.
          </p>
        </div>
      )}
      {/* =========================================================
          REPORT HEADER
      ========================================================= */}
      <section>
        <Link
          href="/dashboard/reports"
          className="no-print inline-flex items-center gap-2 text-[0.9rem] text-cloud-400 transition-colors hover:text-cloud-50"
        >
          <ArrowLeft
            className="size-4"
            aria-hidden
          />

          All reports
        </Link>

        <div className="mt-5 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          {/* LEFT SIDE */}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-cloud-300">
              Report ID: {report.ref}
            </p>

            <h1 className="mt-3 text-[2.2rem] font-bold leading-none tracking-tight text-cloud-50 sm:text-[2.7rem]">
              {report.domain}
            </h1>

            <p className="mt-2 hidden text-sm text-cloud-400 print:block">
              Exported {formatDateTime(Date.now())}. Contains the checks included in the {report.planName} plan
              when this scan ran; locked checks are not part of this export.
            </p>

            <a
              href={report.url}
              target="_blank"
              rel="noreferrer nofollow noopener"
              className="mt-3 inline-flex max-w-full items-center gap-2 truncate text-[0.95rem] text-cloud-300 underline underline-offset-4 transition-colors hover:text-cloud-50"
            >
              <span className="truncate">{report.url}</span>
              <ArrowUpRightIcon />
            </a>

            {/* REPORT ACTIONS */}
            {report.state === "complete" ? (
              <div className="no-print mt-5">
                <ReportActions
                  reportId={report.id}
                  domain={report.domain}
                  canExport={canExport}
                  exportPlanName={exportPlan?.name}
                />
                {showRescans ? (
                  <div className="mt-4">
                    <WeeklyRescanToggle
                      domain={report.domain}
                      enabled={Boolean(schedule?.enabled)}
                      note={rescanNote}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* RIGHT SIDE IMAGE */}
          <div className="hidden w-[280px] shrink-0 lg:block xl:w-[340px]">
            <img
              src="/scan-website.png"
              alt="Website scan"
              className="h-auto w-full object-contain"
            />
          </div>
        </div>
      </section>

      {/* =========================================================
          REPORT METADATA BAR
      ========================================================= */}
      <section className="glass rounded-xl border border-ink-700 px-4 py-4 sm:px-6 sm:py-5">
        <dl className="grid grid-cols-2 gap-y-5 sm:grid-cols-3 lg:grid-cols-6 lg:gap-0">
          <Meta
            icon={CalendarDays}
            label="Run at"
            className="lg:border-r lg:border-ink-700"
          >
            {formatDateTime(report.startedAt)}
          </Meta>

          <Meta
            icon={CheckCircle2}
            label="Plan used"
            className="lg:border-r lg:border-ink-700"
          >
            {report.planName}
          </Meta>

          <Meta
            icon={ScanSearch}
            label="Checks"
            className="lg:border-r lg:border-ink-700"
          >
            {report.checksRun}
          </Meta>

          <Meta
            icon={FileText}
            label="Pages read"
            className="lg:border-r lg:border-ink-700"
          >
            {report.pagesFetched}
            {metrics.partial ? (
              <span className="block text-[0.75rem] font-normal text-amber-400">
                Time limit reached — some pages weren&apos;t read
              </span>
            ) : null}
          </Meta>

          <Meta
            icon={Clock3}
            label="Duration"
            className="lg:border-r lg:border-ink-700"
          >
            {report.durationMs
              ? formatDuration(report.durationMs)
              : "—"}
          </Meta>

          <Meta
            icon={Cpu}
            label="Engine"
          >
            v{report.engineVersion}
          </Meta>
        </dl>
      </section>

      {/* =========================================================
          REPORT CONTENT
      ========================================================= */}
      {report.state === "running" ? (
        <RunningPanel />
      ) : report.state === "failed" ? (
        <FailedPanel
          domain={report.domain}
          message={
            report.errorMessage ??
            "The run did not finish."
          }
        />
      ) : (
        <>
          {/* OVERALL SCORE */}
          <ScorePanel report={report} />

          {/* CATEGORY SCORES */}
          <section>
            <div className="flex flex-wrap items-center gap-2">
              
            </div>

            <div className="mt-4">
              <CategoryBreakdown
                categories={report.categories}
              />
            </div>
          </section>

          {/* FINDINGS */}
          <section>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="t-eyebrow text-cloud-500">
                Findings
              </h2>

              <Badge>
                {plural(
                  report.criticalCount +
                  report.warningCount,
                  "item",
                )}{" "}
                to act on
              </Badge>
            </div>

            <div className="mt-4">
              <AreaSummary counts={areaCounts} />
            </div>

            <div className="mt-8">
              <IssueList issues={findings} />
            </div>
          </section>

          {/* SMART INSIGHTS */}
          <SmartInsights insights={insights} />

          {/* SIGNALS */}
          {hasSignals ? (
            <section>
            <div className="flex flex-col gap-3">
              <h2 className="text-[1.2rem] font-semibold tracking-tight text-cloud-50">
                Signals measured
              </h2>
          
              <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-cloud-300">
                Only the checks your plan ran are shown. The AI and originality figures
                are estimates derived from how the text is written.
              </p>
            </div>
          
            <div className="mt-5">
              <SignalGrid metrics={report.metrics} />
            </div>
          </section>
          ) : null}

          {/* POLICY RISK */}
          {risks.length > 0 ? (
            <section>
            <div className="flex flex-col gap-3">
              <h2 className="text-[1.2rem] font-semibold tracking-tight text-cloud-50">
                Policy risk
              </h2>
          
              <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-cloud-300">
                Ranked by how often each one appears in rejections. This is our reading
                of what we found, not a Google assessment.
              </p>
            </div>
          
            <div className="mt-5">
              <RiskList risks={risks} />
            </div>
          </section>
          ) : null}

          {/* RECOMMENDATIONS */}
          {recommendations.length > 0 ? (
            <section>
            <div className="flex flex-col gap-3">
              <h2 className="text-[1.2rem] font-semibold tracking-tight text-cloud-50">
                What to do, in order
              </h2>
          
              <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-cloud-300">
                Each step is written against something we actually observed on your site.
                Work down the list, then re-check.
              </p>
            </div>
          
            <div className="mt-5">
              <RecommendationList items={recommendations} />
            </div>
          </section>
          ) : null}

          {/* PAGE BY PAGE */}
          {report.pages.length > 0 ? (
            <section>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-[1.2rem] font-semibold tracking-tight text-cloud-50">
                    Page by page
                  </h2>
          
                  <span className="rounded-full border border-ink-700 bg-ink-900 px-2.5 py-1 text-[0.75rem] font-medium text-cloud-50">
                    {plural(report.pages.length, "page")} scored
                  </span>
                </div>
          
                <p className="mt-2 max-w-2xl text-[0.9375rem] leading-relaxed text-cloud-300">
                  Every page we reached is scored individually, so you can quickly see
                  which pages are pulling your website&apos;s overall score down.
                </p>
              </div>
            </div>
          
            <div className="mt-5">
              <PageTable pages={report.pages} />
            </div>
          </section>
          ) : null}

          {/* MORE PAGES THAN THIS PLAN READS */}
          <UnreadPagesTeaser unread={metrics.unreadPages} pageLimit={report.pageLimit} />

          {/* LOCKED FEATURES */}
          {report.locked.length > 0 ? (
            <section className="no-print">
              
              <div className="mt-4">
                <LockedFeatures
                  locked={report.locked}
                />
              </div>
            </section>
          ) : null}

          
          
        </>
      )}
    </div>
  );
}

/* =============================================================
   METADATA ITEM
============================================================= */

function Meta({
  icon: Icon,
  label,
  children,
  className = "",
}: {
  icon: React.ComponentType<{
    className?: string;
  }>;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-3 lg:px-5 lg:first:pl-0 lg:last:pr-0 ${className}`}
    >
      <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-900">
        <Icon
          className="size-4 text-cloud-400"
          aria-hidden
        />
      </div>

      <div className="min-w-0">
        <dt className="text-[0.8125rem] font-medium text-cloud-500">
          {label}
        </dt>

        <dd className="t-data mt-0.5 text-[0.875rem] font-medium leading-snug text-cloud-50">
          {children}
        </dd>
      </div>
    </div>
  );
}

/* =============================================================
   FAILED PANEL
============================================================= */

function FailedPanel({
  domain,
  message,
}: {
  domain: string;
  message: string;
}) {
  return (
    <div className="glass rounded-xl border border-rose-400/20 bg-rose-400/[0.05] p-6">
      <div className="flex gap-3">
        <AlertTriangle
          className="mt-0.5 size-5 shrink-0 text-rose-400"
          aria-hidden
        />

        <div>
          <p className="text-[1rem] font-medium text-cloud-50">
            This scan did not finish
          </p>

          <p className="mt-2 max-w-xl text-[0.875rem] leading-relaxed text-cloud-300">
            {message}
          </p>

          <p className="mt-2 text-[0.8125rem] leading-relaxed text-cloud-500">
            The scan was returned to this month&apos;s
            allowance, so trying again costs you
            nothing.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <ButtonLink
          href={`/dashboard/checker?url=${encodeURIComponent(
            domain,
          )}&run=1`}
          size="sm"
        >
          <RotateCw
            className="size-3.5"
            aria-hidden
          />
          Try again
        </ButtonLink>
      </div>
    </div>
  );
}

/* =============================================================
   EXTERNAL LINK ICON
============================================================= */

function ArrowUpRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="size-4 shrink-0"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}