import type { Metadata } from "next";
import { FileText, Radar } from "lucide-react";

import { PageHeading, StatTile } from "@/components/dashboard/PageHeading";
import { ReportRow } from "@/components/dashboard/ReportRow";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireUser } from "@/lib/auth/guard";
import { countWebsites, listReports } from "@/lib/db/audits";
import { formatDate, plural } from "@/lib/format";

export const metadata: Metadata = {
  title: "Reports",
};

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const user = await requireUser();

  const reports = listReports(user.id);
  const sites = countWebsites(user.id);
  const now = Date.now();

  const complete = reports.filter((report) => report.state === "complete");
  const best = complete.reduce(
    (top, report) => (report.score > top ? report.score : top),
    0,
  );
  const oldest = reports.at(-1);

  return (
    <div className="flex flex-col gap-8">
      <PageHeading
        eyebrow="Reports"
        title="Every scan you have run"
        lede="Reports are stored permanently — they survive logging out and they outlive the plan that paid for them, so you can compare a domain before and after each fix."
        action={
          <ButtonLink href="/dashboard/checker" size="md">
            <Radar className="size-4" aria-hidden />
            New scan
          </ButtonLink>
        }
      />

      {reports.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-5" aria-hidden />}
          title="No reports yet"
          body="Run your first scan and it will appear here. Each run stores the score, the category breakdown and every finding, so nothing is lost when you close the tab."
          action={{ label: "Run a scan", href: "/dashboard/checker" }}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Reports" value={reports.length} />
            <StatTile
              label="Best score"
              value={complete.length > 0 ? best : "—"}
              tone={best >= 85 ? "pass" : best >= 60 ? "warn" : "default"}
              hint={complete.length > 0 ? "out of 100" : "No finished runs"}
            />
            <StatTile label="Websites" value={sites} />
            <StatTile
              label="Since"
              value={
                oldest ? (
                  <span className="text-[1rem]">
                    {formatDate(oldest.startedAt)}
                  </span>
                ) : (
                  "—"
                )
              }
              hint={`${plural(reports.length, "run")} in total`}
            />
          </div>

          <div className="flex flex-col gap-2.5">
            {reports.map((report) => (
              <ReportRow key={report.id} report={report} now={now} />
            ))}
          </div>

          <p className="text-[0.8125rem] leading-relaxed text-cloud-600">
            Deleting a report removes it permanently and does not return the
            scan it used to your monthly allowance.
          </p>
        </>
      )}
    </div>
  );
}
