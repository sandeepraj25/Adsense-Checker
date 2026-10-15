import { AlertTriangle, Check, ChevronDown, CircleSlash, FileText, Wrench } from "lucide-react";

import { Badge, PriorityBadge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { CATEGORY_META, type CategoryKey } from "@/lib/analysis/types";
import type { ReportIssue, IssueStatus } from "@/lib/db/types";
import { AREA_LABEL, CONFIDENCE_LABEL, STATUS_LABEL, areaOf } from "@/lib/report/areas";

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

function sortIssues(issues: ReportIssue[]): ReportIssue[] {
  return [...issues].sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  );
}

export function IssueList({ issues }: { issues: ReportIssue[] }) {
  const critical = sortIssues(issues.filter((i) => i.status === "fail"));
  const warnings = sortIssues(issues.filter((i) => i.status === "warn"));
  const passed = issues.filter((i) => i.status === "pass");
  const errored = issues.filter((i) => i.status === "error");

  return (
    <div className="flex flex-col gap-10">
      {critical.length > 0 ? (
        <Group
          status="fail"
          title="Blockers"
          lede="Fix these before you apply. Each one is a commonly cited reason for rejection — none of them is a Google decision."
          issues={critical}
        />
      ) : null}

      {warnings.length > 0 ? (
        <Group
          status="warn"
          title="Worth fixing"
          lede="Not fatal on their own, but they weaken the application and they are cheap to fix."
          issues={warnings}
        />
      ) : null}

      {errored.length > 0 ? <ErroredGroup issues={errored} /> : null}

      {passed.length > 0 ? <PassedGroup issues={passed} /> : null}
    </div>
  );
}

/* ── severity groups ────────────────────────────────────────────── */

const groupIcon: Record<"fail" | "warn", React.ReactNode> = {
  fail: <AlertTriangle className="size-5 text-rose-400" aria-hidden />,
  warn: <Wrench className="size-5 text-amber-400" aria-hidden />,
};

function Group({
  status,
  title,
  lede,
  issues,
}: {
  status: "fail" | "warn";
  title: string;
  lede: string;
  issues: ReportIssue[];
}) {
  return (
    <section>
      <div className="flex items-center gap-3">
        {groupIcon[status]}

        <h2 className="text-[1.25rem] font-semibold tracking-tight text-cloud-50">
          {title}
        </h2>

        <span className="t-data rounded-md border border-ink-700 bg-ink-850 px-2 py-0.5 text-[0.75rem] font-medium text-cloud-300">
          {issues.length}
        </span>
      </div>

      <p className="mt-2 max-w-3xl text-[0.9375rem] leading-relaxed text-cloud-300 sm:text-[1rem]">
        {lede}
      </p>

      <div className="mt-5 flex flex-col gap-3.5">
        {issues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} />
        ))}
      </div>
    </section>
  );
}

const accent: Record<IssueStatus, string> = {
  fail: "before:bg-rose-400",
  warn: "before:bg-amber-400",
  pass: "before:bg-mint-400",
  error: "before:bg-zinc-400",
};

/**
 * Checks that could not run. Not a verdict on the site — an internal
 * failure on our side — so they are listed plainly, outside the score.
 */
function ErroredGroup({ issues }: { issues: ReportIssue[] }) {
  return (
    <section>
      <div className="flex items-center gap-3">
        <CircleSlash className="size-5 text-cloud-400" aria-hidden />
        <h2 className="text-[1.25rem] font-semibold tracking-tight text-cloud-50">Couldn&apos;t run</h2>
        <span className="t-data rounded-md border border-ink-700 bg-ink-850 px-2 py-0.5 text-[0.75rem] font-medium text-cloud-300">
          {issues.length}
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-[0.9375rem] leading-relaxed text-cloud-300 sm:text-[1rem]">
        These checks hit an error on our side, so they say nothing about your site and are left out of the score.
        Run the scan again later to include them.
      </p>
      <ul className="mt-5 flex flex-col gap-2">
        {issues.map((issue) => (
          <li key={issue.id} className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-3">
            <p className="text-[0.9375rem] font-medium text-cloud-100">{issue.label}</p>
            <p className="mt-0.5 text-[0.875rem] text-cloud-400">{issue.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How many per-page lines a card lists before summarising the rest. */
const MAX_ITEMS = 8;

export function IssueCard({ issue }: { issue: ReportIssue }) {
  const meta = CATEGORY_META[issue.categoryId as CategoryKey];
  const area = areaOf(issue);
  const items = issue.analyzer?.items ?? [];
  const confidence = issue.analyzer?.confidence;

  return (
    <article
      data-area={area}
      data-status={issue.status}
      className={cn(
        "glass group relative overflow-hidden rounded-xl",
        "border border-ink-700 bg-white",
        "p-5 pl-6",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
        accent[issue.status],
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
        <h3 className="min-w-0 break-words text-[1rem] font-semibold text-cloud-50 sm:text-[1.0625rem]">
          {issue.label}
        </h3>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge>{AREA_LABEL[area]}</Badge>
          <PriorityBadge priority={issue.priority} />
        </div>
      </div>

      <p className="mt-3 break-words text-[0.9375rem] leading-relaxed text-cloud-200 sm:text-[1rem]">
        {issue.detail}
      </p>

      {confidence && confidence !== "high" ? (
        <p className="mt-2 text-[0.8125rem] text-cloud-400">{CONFIDENCE_LABEL[confidence]}</p>
      ) : null}

      {items.length > 0 ? (
        <ul className="mt-4 flex flex-col divide-y divide-ink-700 rounded-xl border border-ink-700 bg-ink-900">
          {items.slice(0, MAX_ITEMS).map((item, index) => (
            <li key={index} className="px-4 py-3">
              <p className="break-words text-[0.875rem] leading-relaxed text-cloud-200">{item.message}</p>
              {item.pageUrl ? (
                <p className="mt-1 flex min-w-0 items-start gap-1.5 text-[0.8125rem] text-cloud-400">
                  <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span className="sr-only">Page: </span>
                  <span className="break-anywhere font-mono">{item.pageUrl}</span>
                </p>
              ) : null}
              {item.evidence ? (
                <p className="mt-1 break-anywhere font-mono text-[0.8125rem] leading-relaxed text-cloud-300">
                  {item.evidence}
                </p>
              ) : null}
            </li>
          ))}
          {items.length > MAX_ITEMS ? (
            <li className="px-4 py-2.5 text-[0.8125rem] text-cloud-400">
              and {items.length - MAX_ITEMS} more like these
            </li>
          ) : null}
        </ul>
      ) : issue.evidence ? (
        <div className="mt-4 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3">
          <p className="break-anywhere font-mono text-[0.8125rem] leading-relaxed text-cloud-300">
            {issue.evidence}
          </p>
        </div>
      ) : null}

      {issue.recommendation ? (
        <div className="mt-4 flex gap-3 border-t border-ink-700 pt-4">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-azure-400/15 bg-azure-400/[0.06]">
            <Wrench
              className="size-3.5 text-azure-600"
              aria-hidden
            />
          </div>

          <div className="min-w-0">
            <span className="mb-1 block text-[0.8125rem] font-semibold text-cloud-50">
              How to fix
            </span>

            <p className="break-words text-[0.9375rem] leading-relaxed text-cloud-200 sm:text-[1rem]">
              {issue.recommendation}
            </p>
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-[0.75rem] text-cloud-400">
        {STATUS_LABEL[issue.status]}
        {meta ? <> · scored under {meta.name}</> : null}
        {" · "}
        <span className="font-mono">{issue.checkId}</span>
      </p>
    </article>
  );
}

/* ── passed checks ──────────────────────────────────────────────── */

function PassedGroup({ issues }: { issues: ReportIssue[] }) {
  const byCategory = new Map<string, ReportIssue[]>();

  for (const issue of issues) {
    const bucket = byCategory.get(issue.categoryId);

    if (bucket) {
      bucket.push(issue);
    } else {
      byCategory.set(issue.categoryId, [issue]);
    }
  }

  return (
    <details className="group/passed">
      <summary
        className={cn(
          "glass flex cursor-pointer list-none items-center gap-3 rounded-xl",
          "border border-ink-700 bg-ink-900 px-5 py-4",
          "transition-all duration-300",
          "hover:border-ink-700 hover:bg-ink-800",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-400",
        )}
      >
        <div className="grid size-8 place-items-center rounded-lg border border-mint-400/15 bg-mint-400/[0.06]">
          <Check className="size-4 text-mint-400" aria-hidden />
        </div>

        <span className="text-[1rem] font-medium text-cloud-50">
          {issues.length} checks passed
        </span>

        <ChevronDown
          className="ml-auto size-5 text-cloud-500 transition-transform duration-300 group-open/passed:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="mt-4 flex flex-col gap-6">
        {[...byCategory.entries()].map(([categoryId, list]) => (
          <div key={categoryId}>
            <p className="text-[0.75rem] font-medium tracking-[0.16em] text-cloud-400">
              {CATEGORY_META[categoryId as CategoryKey]?.name ?? categoryId}
            </p>

            <ul className="mt-3 flex flex-col gap-2.5">
              {list.map((issue) => (
                <li
                  key={issue.id}
                  className={cn(
                    "flex gap-3 rounded-xl",
                    "border border-ink-700 bg-ink-900",
                    "px-4 py-3.5",
                    "transition-colors duration-300 hover:bg-ink-800",
                  )}
                >
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-mint-400"
                    aria-hidden
                  />

                  <div className="min-w-0">
                    <p className="text-[0.9375rem] font-medium text-cloud-200">
                      {issue.label}
                    </p>

                    <p className="mt-1 text-[0.875rem] leading-relaxed text-cloud-400">
                      {issue.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}