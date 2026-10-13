import type { Metadata } from "next";

import { CheckerPanel } from "@/components/dashboard/CheckerPanel";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { ReportRow } from "@/components/dashboard/ReportRow";
import { requireUser } from "@/lib/auth/guard";
import { listReports } from "@/lib/db/audits";
import { getActiveSubscription } from "@/lib/db/billing";
import { normalizeDomain } from "@/lib/domain";
import { entitlementBlock } from "@/lib/entitlement";
import { formatDate } from "@/lib/format";
import { requirePlan } from "@/lib/plan-catalogue";
import { checkCountFor } from "@/lib/analysis/checks";

export const metadata: Metadata = {
  title: "New scan",
};

export const dynamic = "force-dynamic";

export default async function CheckerPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; run?: string }>;
}) {
  const { url, run } = await searchParams;
  const user = await requireUser();

  const subscription = getActiveSubscription(user.id);
  const blocked = entitlementBlock(subscription);
  const initialUrl = normalizeDomain(url ?? "") ?? "";

  // The subscription's own feature snapshot decides what will run, so the
  // number quoted here is the number of checks this account will actually
  // get — not the size of the engine.
  const features = subscription?.features ?? requirePlan("free").features;
  const checks = checkCountFor(features);

  const recent = listReports(user.id, 3);
  const now = Date.now();

  return (
    <div className="flex flex-col gap-8">
      <PageHeading
        eyebrow="New scan"
        title="Run a check"
      />

      <CheckerPanel
        initialUrl={initialUrl}
        autoRun={run === "1"}
        checks={checks}
        usage={
          subscription
            ? {
                used: subscription.scansUsed,
                limit: subscription.scanLimit,
                remaining: subscription.scansRemaining,
                resetsOn: formatDate(subscription.cycleEnd),
              }
            : null
        }
        blocked={blocked}
      />

      {recent.length > 0 ? (
        <section>
          <h2 className="t-eyebrow text-cloud-600">Recent runs</h2>
          <div className="mt-4 flex flex-col gap-2.5">
            {recent.map((report) => (
              <ReportRow key={report.id} report={report} now={now} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
 
}
