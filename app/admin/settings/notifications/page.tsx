import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { AlertSettingsForm, RetryButton } from "@/components/admin/AlertSettings";
import { NoRows, Panel, TableShell, Td, Th, Tr } from "@/components/admin/Panels";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { listCheckoutSessions } from "@/lib/alerts/checkout";
import { listNotifications, MAX_ATTEMPTS, notificationCounts } from "@/lib/alerts/notify";
import { alertEmailSetting, graceMinutes, lastJobRun } from "@/lib/alerts/settings";
import { emailStatus } from "@/lib/email";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { SCHEDULED_JOBS, scheduleHealth, schedulerSecretConfigured, type ScheduledJob } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export const metadata = { title: "Notifications — Admin" };

const STATUS: Record<string, { label: string; tone: "pass" | "warn" | "fail" | "neutral" | "brand" }> = {
  sent: { label: "Sent", tone: "pass" },
  pending: { label: "Queued", tone: "brand" },
  sending: { label: "Sending", tone: "brand" },
  retry: { label: "Will retry", tone: "warn" },
  failed: { label: "Failed", tone: "fail" },
  skipped: { label: "Not sent", tone: "neutral" },
};

const TRIGGER_LABEL: Record<"scheduler" | "background" | "admin", string> = {
  scheduler: "by the scheduler",
  background: "by the server's background check",
  admin: "by an admin (Run now)",
};

const JOB_LABEL: Record<ScheduledJob, string> = {
  "checkout-alerts": "Payment & checkout alerts",
  ml: "Prediction feedback & training",
  rescans: "Weekly rescans (Pro)",
};

const HEALTH_LABEL: Record<ReturnType<typeof scheduleHealth>["state"], string> = {
  not_configured: "Not configured",
  never_called: "Not verified — never called",
  stale: "Not called recently",
  failing: "Last call failed",
  verified: "Verified",
};

const CHECKOUT_STATUS: Record<string, string> = {
  in_progress: "Details saved",
  payment_started: "Pay pressed",
  paid: "Paid",
  abandoned: "Abandoned",
  converted: "Bought later",
};

/**
 * Payment & checkout alerts. The admin layout has required an
 * administrator; every action on this page goes through an admin API that
 * checks again.
 */
export default async function NotificationSettingsPage() {
  const setting = alertEmailSetting();
  const provider = emailStatus();
  const lastRun = lastJobRun();
  const counts = notificationCounts();
  const history = listNotifications(100);
  const checkouts = listCheckoutSessions(30);
  const cronConfigured = schedulerSecretConfigured();
  const now = Date.now();
  const health = Object.fromEntries(SCHEDULED_JOBS.map((job) => [job, scheduleHealth(job, now)])) as Record<ScheduledJob, ReturnType<typeof scheduleHealth>>;
  const alertsSchedule = health["checkout-alerts"];
  const backgroundTick = process.env.CHECKOUT_ALERTS_BACKGROUND?.trim().toLowerCase() !== "off";
  const active = Boolean(setting.email) && provider.configured;

  const warnings: string[] = [];
  if (!setting.email) warnings.push("No alert email is set, so payment and checkout alerts are off. Nothing will be sent until you add one.");
  if (!provider.configured) warnings.push(`Email delivery isn't configured: ${provider.problem} Alerts are queued and retried, but none can be sent until this is fixed.`);
  if (provider.configured && provider.provider === "console") warnings.push("Development mode: alerts are printed to the server log instead of being emailed.");
  if (!cronConfigured) warnings.push("No scheduler is configured (CRON_SECRET). Abandoned checkouts are only checked while the server is awake (every 5 minutes) — on a host that sleeps when idle, they may not be checked at all. Set up the scheduled job in the README.");
  else if (alertsSchedule.state !== "verified") warnings.push(`Scheduler not verified: ${alertsSchedule.message}`);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Notifications"
        lede="Email alerts when a payment fails, or when a customer fills in checkout but doesn't press Pay."
      />

      <div
        role="status"
        className={`flex gap-3 rounded-xl border px-4 py-3.5 ${active ? "border-mint-400/25 bg-mint-400/[0.06]" : "border-amber-400/30 bg-amber-400/[0.07]"}`}
      >
        {active ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-mint-400" aria-hidden /> : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden />}
        <div className="text-[0.9375rem] leading-relaxed">
          <p className="font-semibold text-cloud-50">
            {active ? `Alerts are on — they go to ${setting.email}` : "Alerts are not active"}
          </p>
          <p className="mt-0.5 text-cloud-300">
            {active
              ? `Delivered through ${provider.configured ? provider.label : "—"}.`
              : "Fix the items below to start receiving payment and checkout alerts."}
          </p>
        </div>
      </div>

      {warnings.length ? (
        <ul className="space-y-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.05] px-4 py-3.5 text-[0.9375rem] leading-relaxed text-cloud-200" aria-label="Needs attention">
          {warnings.map((w) => (
            <li key={w} className="flex gap-2.5">
              <AlertTriangle className="mt-1 size-4 shrink-0 text-amber-400" aria-hidden />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Panel title="Alert settings" description="One address for both alert types. Changes apply to the next alert sent.">
        <AlertSettingsForm email={setting.email} graceMinutes={graceMinutes()} />
        <dl className="mt-5 grid gap-3 border-t border-ink-700 pt-4 text-[0.875rem] sm:grid-cols-3">
          <div>
            <dt className="text-cloud-400">Currently set</dt>
            <dd className="mt-0.5 text-cloud-50">{setting.email ?? "Not set"}</dd>
            {setting.updatedAt ? (
              <dd className="text-[0.8125rem] text-cloud-400">
                {formatDateTime(setting.updatedAt)}
                {setting.updatedBy ? ` by ${setting.updatedBy}` : ""}
              </dd>
            ) : null}
          </div>
          <div>
            <dt className="text-cloud-400">Last check for abandoned checkouts</dt>
            <dd className="mt-0.5 text-cloud-50">
              {lastRun ? formatDateTime(lastRun.at) : "Not run yet"}
              {lastRun?.trigger ? ` · ${TRIGGER_LABEL[lastRun.trigger]}` : ""}
            </dd>
            {lastRun ? <dd className="text-[0.8125rem] text-cloud-400">{lastRun.summary}</dd> : null}
          </div>
          <div>
            <dt className="text-cloud-400">Schedule</dt>
            <dd className="mt-0.5 text-cloud-50">{HEALTH_LABEL[alertsSchedule.state]}</dd>
            <dd className="text-[0.8125rem] text-cloud-400">
              {"last" in alertsSchedule ? `Last scheduler call ${formatDateTime(alertsSchedule.last.at)}. ` : ""}
              {backgroundTick ? "The server also checks every 5 minutes while it is awake." : "The server's own 5-minute check is off."}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title="Scheduled jobs"
        description="What an outside scheduler has actually called, with the CRON_SECRET. The server's own background check and the Run now button don't count here."
      >
        <TableShell
          head={
            <>
              <Th>Job</Th>
              <Th>Endpoint</Th>
              <Th>Status</Th>
              <Th>Last scheduler call</Th>
            </>
          }
        >
          {SCHEDULED_JOBS.map((job) => {
            const h = health[job];
            return (
              <Tr key={job}>
                <Td>{JOB_LABEL[job]}</Td>
                <Td className="font-mono text-[0.8125rem]">POST /api/internal/jobs/{job}</Td>
                <Td>
                  <Badge tone={h.state === "verified" ? "pass" : h.state === "failing" ? "fail" : "warn"}>{HEALTH_LABEL[h.state]}</Badge>
                  <span className="mt-1 block text-[0.8125rem] text-cloud-400">{h.message}</span>
                </Td>
                <Td>
                  {"last" in h ? formatDateTime(h.last.at) : "Never"}
                  {"last" in h ? <span className="mt-1 block text-[0.8125rem] text-cloud-400">{h.last.summary}</span> : null}
                </Td>
              </Tr>
            );
          })}
        </TableShell>
      </Panel>

      <Panel
        title="Alert history"
        description={`${counts.sent} sent · ${counts.retry + counts.pending} waiting · ${counts.failed} failed · ${counts.skipped} not sent`}
      >
        {history.length === 0 ? (
          <NoRows>No alerts yet. A confirmed payment failure or an abandoned checkout will appear here.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>When</Th>
                <Th>Type</Th>
                <Th>Customer</Th>
                <Th>Plan</Th>
                <Th>Expected amount</Th>
                <Th>Sent to</Th>
                <Th>Delivery</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </>
            }
          >
              {history.map((row) => {
                const status = STATUS[row.status] ?? STATUS.pending;
                return (
                  <Tr key={row.id}>
                    <Td mono>{formatDateTime(row.createdAt)}</Td>
                    <Td>{row.type === "payment_failed" ? "Payment failed" : "Abandoned checkout"}</Td>
                    <Td>{row.customer ?? "—"}</Td>
                    <Td>{row.planName ?? "—"}</Td>
                    <Td mono>{row.amountMinor !== null && row.currency ? formatMoney(row.amountMinor, row.currency) : "—"}</Td>
                    <Td>{row.destination ?? "—"}</Td>
                    <Td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <p className="mt-1 text-[0.8125rem] text-cloud-400">
                        {row.sentAt ? `Sent ${formatDateTime(row.sentAt)}` : `${row.attempts}/${MAX_ATTEMPTS} attempts`}
                        {row.status === "retry" && row.nextAttemptAt ? ` · next ${formatDateTime(row.nextAttemptAt)}` : ""}
                      </p>
                      {row.lastError && row.status !== "sent" ? <p className="mt-0.5 max-w-xs text-[0.8125rem] text-rose-400">{row.lastError}</p> : null}
                    </Td>
                    <Td>{row.retryable ? <RetryButton id={row.id} /> : null}</Td>
                  </Tr>
                );
              })}
            </TableShell>
        )}
      </Panel>

      <Panel
        title="Recent checkouts"
        description="Billing details customers saved on the checkout page. Records with no payment are deleted after 30 days."
      >
        {checkouts.length === 0 ? (
          <NoRows>No checkout details saved yet.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>Record</Th>
                <Th>Customer</Th>
                <Th>Plan</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
                <Th>Details saved</Th>
              </>
            }
          >
              {checkouts.map((row) => (
                <Tr key={row.id}>
                  <Td mono>
                    <span id={row.id}>{row.id}</span>
                  </Td>
                  <Td>
                    {row.billingName}
                    <p className="text-[0.8125rem] text-cloud-400">{row.billingEmail}</p>
                  </Td>
                  <Td>{row.planName}</Td>
                  <Td mono>{formatMoney(row.amountMinor, row.currency)}</Td>
                  <Td>
                    <Badge tone={row.status === "abandoned" ? "warn" : row.status === "paid" ? "pass" : "neutral"}>
                      {CHECKOUT_STATUS[row.status] ?? row.status}
                    </Badge>
                  </Td>
                  <Td mono>{formatDateTime(row.detailsSavedAt)}</Td>
                </Tr>
              ))}
            </TableShell>
        )}
      </Panel>

      <p className="flex gap-2 text-[0.875rem] leading-relaxed text-cloud-400">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        A payment-failed alert is sent only when the payment provider reports the payment as failed — not for a pending
        payment, a closed payment window or a lost connection. A checkout counts as abandoned only after the wait above,
        with no Pay attempt, and only once.
      </p>
    </div>
  );
}
