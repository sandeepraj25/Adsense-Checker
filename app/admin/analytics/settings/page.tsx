import Link from "next/link";
import { ArrowLeft, CheckCircle2, CircleSlash } from "lucide-react";

import { Panel } from "@/components/admin/Panels";
import { AnalyticsSettingsForm, IgnoreThisBrowser } from "@/components/admin/analytics/SettingsForm";
import { fmtDateIn, fmtInt } from "@/components/admin/analytics/format";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { requireAdmin } from "@/lib/auth/guard";
import { analyticsSettingsWithMeta } from "@/lib/analytics/settings";
import { lastPurge, trackingStatus } from "@/lib/analytics/store";

export const dynamic = "force-dynamic";

export const metadata = { title: "Analytics settings — Admin" };

function timezones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    list = [];
  }
  return [...new Set(["UTC", "Asia/Kolkata", current, ...list])].sort();
}

export default async function AnalyticsSettingsPage() {
  const admin = await requireAdmin();
  const settings = analyticsSettingsWithMeta();
  const status = trackingStatus();
  const purge = lastPurge();
  const tz = settings.timezone;
  const recent = status.lastBrowserEventAt !== null && Date.now() - status.lastBrowserEventAt < 7 * 86_400_000;
  const { updatedAt, updatedBy, ...plain } = settings;

  return (
    <div className="space-y-6">
      <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-[0.875rem] font-medium text-cloud-300 hover:text-cloud-50">
        <ArrowLeft className="size-4" aria-hidden />
        Website analytics
      </Link>
      <PageHeading eyebrow="Website analytics" title="Analytics settings" lede="How visits are recorded, for how long, and how reports are shown." />

      <Panel title="Tracking status" description="Read from the stored events just now.">
        <div className="flex items-start gap-3">
          {settings.enabled ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-mint-400" aria-hidden /> : <CircleSlash className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden />}
          <div>
            <p className="font-semibold text-cloud-50">
              {!settings.enabled ? "Tracking is off" : recent ? "Tracking is on and receiving visits" : status.lastBrowserEventAt ? "Tracking is on, but no visits in the last 7 days" : "Tracking is on — waiting for the first visit"}
            </p>
            <p className="mt-0.5 text-[0.875rem] text-cloud-400">
              {settings.consentMode === "ask" ? "Asking visitors before remembering their browser." : "Cookie-free mode: nothing is stored on visitors' devices."} Admin pages, signed-in admins
              {settings.internalIps.length ? `, ${settings.internalIps.length} internal address${settings.internalIps.length === 1 ? "" : "es"}` : ""} and bots are excluded.
            </p>
          </div>
        </div>
        <dl className="mt-4 grid gap-4 border-t border-ink-700 pt-4 text-[0.875rem] sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-cloud-400">Last tracked visit</dt>
            <dd className="mt-0.5 text-cloud-50">{status.lastBrowserEventAt ? fmtDateIn(status.lastBrowserEventAt, tz, true) : "None yet"}</dd>
          </div>
          <div>
            <dt className="text-cloud-400">Last event of any kind</dt>
            <dd className="mt-0.5 text-cloud-50">{status.lastEventAt ? fmtDateIn(status.lastEventAt, tz, true) : "None yet"}</dd>
          </div>
          <div>
            <dt className="text-cloud-400">Events in the last 24 hours</dt>
            <dd className="t-data mt-0.5 text-cloud-50">{fmtInt(status.eventsLast24h)}</dd>
          </div>
          <div>
            <dt className="text-cloud-400">Stored</dt>
            <dd className="t-data mt-0.5 text-cloud-50">
              {fmtInt(status.storedEvents)} events · {fmtInt(status.storedSessions)} visits
            </dd>
            <dd className="text-[0.8125rem] text-cloud-400">{status.firstEventAt ? `since ${fmtDateIn(status.firstEventAt, tz)}` : ""}</dd>
          </div>
        </dl>
        <p className="mt-3 text-[0.8125rem] text-cloud-400">
          Retention clean-up {purge ? `last ran ${fmtDateIn(purge.at, tz, true)} (${fmtInt(purge.events)} events removed)` : "hasn't run yet"}. It runs with the scheduled alerts job and on new visits, at most every 6 hours.
        </p>
      </Panel>

      <Panel
        title="Settings"
        description={updatedAt ? `Last changed ${fmtDateIn(updatedAt, tz, true)}${updatedBy ? ` by ${updatedBy}` : ""}. Changes are written to the audit log.` : "Using the defaults. Changes are written to the audit log."}
      >
        <AnalyticsSettingsForm initial={plain} timezones={timezones(tz)} />
      </Panel>

      <Panel title="This browser" description={`Signed in as ${admin.email}, you're already excluded. Use this for testing the public site while signed out.`}>
        <IgnoreThisBrowser />
      </Panel>

      <Panel title="What is stored, and what isn't">
        <ul className="list-disc space-y-1.5 pl-5 text-[0.875rem] leading-relaxed text-cloud-300">
          <li>Per visit: landing and exit page path, referring host name, utm_* tags, device type, browser and OS family, and a pseudonymous visitor key.</li>
          <li>Paths have record ids replaced by [id]. Query strings, full URLs, form contents, passwords, codes and payment details are never sent or stored.</li>
          <li>IP addresses are not stored. The visitor key is a hash of IP and browser with a salt that is replaced every day and then discarded, so it can&apos;t be traced back or linked across days.</li>
          <li>In “Ask visitors” mode, a random ID is kept in the visitor&apos;s browser only after they allow it; the server stores only a keyed hash of it. Visitors can change their choice from the footer link “Analytics choices”.</li>
          <li>Browsers that send Do Not Track or Global Privacy Control send nothing. No third-party scripts or cookies are used for analytics.</li>
          <li>Deleting an account removes its link to analytics events. Events older than the retention period are deleted.</li>
          <li>Accounts, scans and revenue come from the app&apos;s own records and are not affected by these settings. Security logging (audit log, sign-in limits, payment verification) can&apos;t be changed here.</li>
        </ul>
      </Panel>
    </div>
  );
}
