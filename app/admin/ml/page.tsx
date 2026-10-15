import { AlertTriangle, BrainCircuit, CheckCircle2, Info, XCircle } from "lucide-react";

import { RetrainButton, RollbackButton } from "@/components/admin/MlControls";
import { NoRows, Panel, StatGrid, TableShell, Td, Th, Tr } from "@/components/admin/Panels";
import { PageHeading, StatTile } from "@/components/dashboard/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/format";
import { MIN_LABELED_EXAMPLES, MIN_PER_CLASS, MODEL_LIMITATIONS, rejectionReasonLabel } from "@/lib/ml/constants";
import { describeFeature } from "@/lib/ml/describe";
import { feedbackCounts, recentFeedback } from "@/lib/ml/feedback";
import { FEATURE_SCHEMA } from "@/lib/ml/features";
import { trainingHourUtc } from "@/lib/ml/job";
import {
  activeModelRow,
  labelStats,
  lastTrainingAttempt,
  listEvents,
  listModelVersions,
  toModelVersion,
  trainingRunning,
  trainingStage,
  type ModelVersion,
} from "@/lib/ml/store";
import { ACCEPTANCE } from "@/lib/ml/train";

export const dynamic = "force-dynamic";

export const metadata = { title: "Prediction model — Admin" };

const EVENT: Record<string, { label: string; tone: "pass" | "warn" | "fail" | "neutral" | "brand" }> = {
  trained: { label: "Trained", tone: "brand" },
  promoted: { label: "Promoted", tone: "pass" },
  not_promoted: { label: "Not promoted", tone: "warn" },
  skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "fail" },
  rolled_back: { label: "Rolled back", tone: "warn" },
};

const VERSION_STATUS: Record<string, { label: string; tone: "pass" | "warn" | "fail" | "neutral" | "brand" }> = {
  active: { label: "Active", tone: "pass" },
  retired: { label: "Previous", tone: "neutral" },
  rejected: { label: "Did not pass", tone: "fail" },
  candidate: { label: "Candidate", tone: "brand" },
};

const FEEDBACK_STATUS: Record<string, "pass" | "warn" | "fail" | "neutral" | "brand"> = {
  accepted: "pass",
  deferred: "warn",
  recorded: "neutral",
  duplicate: "neutral",
  superseded: "neutral",
  refused: "fail",
};

const OUTCOME: Record<string, string> = { approved: "Approved", rejected: "Rejected", not_applied: "Not applied yet" };

function num(value: number | undefined, digits = 3): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function pct(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function parse(row: ReturnType<typeof activeModelRow>): ModelVersion | null {
  if (!row) return null;
  try {
    return toModelVersion(row);
  } catch {
    return null;
  }
}

/**
 * Admin → Prediction model. The admin layout has required an
 * administrator; the retrain and restore buttons go through admin APIs
 * that check again.
 */
export default async function PredictionModelPage() {
  const now = Date.now();
  const stats = labelStats(FEATURE_SCHEMA);
  const feedback = feedbackCounts(now);
  const active = parse(activeModelRow());
  const versions = listModelVersions(15);
  const events = listEvents(30);
  const answers = recentFeedback(25);
  const running = trainingRunning(now);
  const stage = trainingStage();
  const lastAttempt = lastTrainingAttempt();
  const lastFailure = events.find((e) => e.event === "failed");
  const progress = Math.min(100, Math.round((stats.usable / MIN_LABELED_EXAMPLES) * 100));

  const weights = active
    ? active.model.normalizer.features
        .map((feature, i) => ({ feature, weight: active.model.weights[i] ?? 0 }))
        .filter((w) => w.weight !== 0)
    : [];
  const positive = [...weights].sort((a, b) => b.weight - a.weight).filter((w) => w.weight > 0).slice(0, 8);
  const negative = [...weights].sort((a, b) => a.weight - b.weight).filter((w) => w.weight < 0).slice(0, 8);
  const v = active?.metrics.validation;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Prediction model"
        lede="The approval estimate, learned locally from outcomes your users report. No outside AI service is involved."
      />

      <div
        role="status"
        className={`flex gap-3 rounded-xl border px-4 py-3.5 ${active ? "border-mint-400/25 bg-mint-400/[0.06]" : "border-azure-500/20 bg-azure-500/[0.05]"}`}
      >
        {active ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-mint-400" aria-hidden /> : <BrainCircuit className="mt-0.5 size-5 shrink-0 text-azure-600" aria-hidden />}
        <div className="text-[0.9375rem] leading-relaxed">
          <p className="font-semibold text-cloud-50">
            {active ? `Trained model ${active.version} is active` : "Rule-based estimates (cold start)"}
          </p>
          <p className="mt-0.5 text-cloud-300">
            {active
              ? `Trained ${formatDateTime(active.trainedAt)} on ${active.trainCount} examples, validated on ${active.validationCount} from sites it never saw.`
              : `A trained model is used only after ${MIN_LABELED_EXAMPLES} usable labels, with at least ${MIN_PER_CLASS} approved and ${MIN_PER_CLASS} rejected. Until then every estimate is shown as “Estimated (rule-based)”: 0.8 × readiness score + 20 × (1 − min(high-priority failures, 5) ÷ 5).`}
          </p>
          {!active ? (
            <div className="mt-3 max-w-md">
              <div className="flex justify-between text-[0.8125rem] text-cloud-400">
                <span>Usable labels</span>
                <span className="t-data">
                  {stats.usable} / {MIN_LABELED_EXAMPLES}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-900">
                <span className="grad-brand block h-full rounded-full" style={{ width: `${progress}%` }} />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {lastFailure && (!lastAttempt || lastFailure.created_at >= lastAttempt) ? (
        <div role="alert" className="flex gap-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-4 py-3.5 text-[0.9375rem] leading-relaxed">
          <XCircle className="mt-0.5 size-5 shrink-0 text-rose-400" aria-hidden />
          <div>
            <p className="font-semibold text-cloud-50">The last training run failed</p>
            <p className="mt-0.5 text-cloud-300">
              {formatDateTime(lastFailure.created_at)} — {lastFailure.detail}
            </p>
          </div>
        </div>
      ) : null}

      <StatGrid>
        <StatTile label="Usable labels" value={stats.usable} hint={`${stats.labelled} answers stored · ${stats.scans} scans collected`} />
        <StatTile label="Approved" value={stats.approved} tone="pass" hint={stats.approved + stats.rejected ? `${pct(stats.approved / (stats.approved + stats.rejected))} of accepted labels` : "No labels yet"} />
        <StatTile label="Rejected" value={stats.rejected} tone={stats.rejected ? "fail" : "default"} hint={stats.reasons.length ? `Most common: ${rejectionReasonLabel(stats.reasons[0]!.reason)}` : "No reasons yet"} />
        <StatTile
          label="Waiting"
          value={stats.deferred + feedback.due}
          tone={stats.deferred + feedback.due ? "warn" : "default"}
          hint={`${stats.deferred} deferred (new accounts) · ${feedback.due} prompts due`}
        />
      </StatGrid>

      <Panel
        title="Current model"
        description={`Retrains nightly at ${String(trainingHourUtc()).padStart(2, "0")}:00 UTC when labels have changed. ${lastAttempt ? `Last attempt ${formatDateTime(lastAttempt)}.` : "No training attempt yet."}`}
        action={<RetrainButton running={Boolean(running)} />}
      >
        {running ? (
          <p className="mb-4 flex items-center gap-2 text-[0.875rem] text-azure-600">
            <Info className="size-4" aria-hidden />
            Training in progress{stage && stage.stage !== "idle" ? `: ${stage.stage}` : ""} (started {formatDateTime(running.since)}).
          </p>
        ) : null}
        {active && v ? (
          <div className="space-y-5">
            <dl className="grid gap-4 text-[0.875rem] sm:grid-cols-4">
              <div>
                <dt className="text-cloud-400">Version</dt>
                <dd className="t-data mt-0.5 text-cloud-50">{active.version}</dd>
              </div>
              <div>
                <dt className="text-cloud-400">Algorithm</dt>
                <dd className="mt-0.5 text-cloud-50">
                  Logistic regression{active.reasonModel ? " + softmax (reasons)" : ""}
                </dd>
                <dd className="text-[0.8125rem] text-cloud-400">
                  {active.model.normalizer.features.length} features · {active.model.epochs} epochs · L2 {active.model.hyper.lambda}
                </dd>
              </div>
              <div>
                <dt className="text-cloud-400">Dataset</dt>
                <dd className="mt-0.5 text-cloud-50">
                  {active.metrics.dataset.usable} examples · {active.metrics.dataset.groups} sites
                </dd>
                <dd className="text-[0.8125rem] text-cloud-400">
                  Snapshot <span className="t-data">{active.datasetSnapshot}</span> · schema {active.featureSchema}
                </dd>
              </div>
              <div>
                <dt className="text-cloud-400">Activated</dt>
                <dd className="mt-0.5 text-cloud-50">{active.activatedAt ? formatDateTime(active.activatedAt) : "—"}</dd>
              </div>
            </dl>

            <div>
              <p className="text-[0.8125rem] font-medium text-cloud-400">Validation on held-out sites ({v.n} examples)</p>
              <dl className="mt-2 grid grid-cols-2 gap-3 text-[0.875rem] sm:grid-cols-4 lg:grid-cols-8">
                {[
                  ["AUC", num(v.auc)],
                  ["Log loss", num(v.logLoss)],
                  ["Base-rate log loss", num(v.baselineLogLoss)],
                  ["Calibration error", num(v.ece)],
                  ["Brier", num(v.brier)],
                  ["Accuracy", pct(v.accuracy)],
                  ["Precision", pct(v.precision)],
                  ["Recall", pct(v.recall)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-ink-700 px-3 py-2">
                    <dt className="text-[0.75rem] text-cloud-400">{label}</dt>
                    <dd className="t-data mt-0.5 text-cloud-50">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <ul className="space-y-1.5 text-[0.875rem]">
              {active.metrics.criteria.map((c) => (
                <li key={c.name} className="flex gap-2">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-mint-400" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden />}
                  <span className="text-cloud-200">
                    <span className="font-medium text-cloud-50">{c.name}:</span> {c.detail}
                  </span>
                </li>
              ))}
              {active.metrics.reasons ? (
                <li className="flex gap-2">
                  <Info className="mt-0.5 size-4 shrink-0 text-cloud-400" aria-hidden />
                  <span className="text-cloud-300">Rejection reasons: {active.metrics.reasons.note}</span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <NoRows>No trained model yet. Estimates are rule-based until the thresholds above are met and a model passes validation.</NoRows>
        )}
      </Panel>

      {active ? (
        <Panel
          title="Strongest factors"
          description="Weights on standardised features: how strongly each signal is associated with approval in the training data. Association, not cause."
        >
          <div className="grid gap-6 md:grid-cols-2">
            {[
              { title: "Associated with approval", rows: positive, tone: "text-mint-400" },
              { title: "Associated with rejection", rows: negative, tone: "text-rose-400" },
            ].map((group) => (
              <div key={group.title}>
                <p className="text-[0.8125rem] font-medium text-cloud-400">{group.title}</p>
                {group.rows.length === 0 ? (
                  <p className="mt-2 text-[0.875rem] text-cloud-400">None.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-ink-850">
                    {group.rows.map((w) => (
                      <li key={w.feature} className="flex items-baseline justify-between gap-4 py-2 text-[0.875rem]">
                        <span className="min-w-0 text-cloud-200">
                          {describeFeature(w.feature)}
                          <span className="t-data block truncate text-[0.75rem] text-cloud-400">{w.feature}</span>
                        </span>
                        <span className={`t-data shrink-0 ${group.tone}`}>
                          {w.weight > 0 ? "+" : ""}
                          {w.weight.toFixed(3)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Model versions"
        description={`A candidate becomes active only if it passes every check: at least ${ACCEPTANCE.minValidation} validation examples, AUC ≥ ${ACCEPTANCE.minAuc}, log loss at least ${ACCEPTANCE.minBaselineGain} better than guessing the base rate, calibration error ≤ ${ACCEPTANCE.maxEce}, and no more than ${ACCEPTANCE.maxLogLossRegression} worse log loss or ${ACCEPTANCE.maxAucRegression} lower AUC than the active model on the same sites.`}
      >
        {versions.length === 0 ? (
          <NoRows>No model has been trained yet.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>Version</Th>
                <Th>Status</Th>
                <Th>Trained</Th>
                <Th>Train / validation</Th>
                <Th>AUC</Th>
                <Th>Log loss</Th>
                <Th>Decision</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </>
            }
          >
            {versions.map((row) => {
              const status = VERSION_STATUS[row.status] ?? VERSION_STATUS.candidate!;
              let metrics: { auc?: number; logLoss?: number } = {};
              try {
                metrics = (JSON.parse(row.metrics_json) as { validation?: { auc?: number; logLoss?: number } }).validation ?? {};
              } catch {
                /* unreadable metrics show as — */
              }
              return (
                <Tr key={row.id}>
                  <Td mono>{row.version}</Td>
                  <Td>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </Td>
                  <Td mono>{formatDateTime(row.trained_at)}</Td>
                  <Td mono>
                    {row.train_count} / {row.validation_count}
                  </Td>
                  <Td mono>{num(metrics.auc)}</Td>
                  <Td mono>{num(metrics.logLoss)}</Td>
                  <Td className="max-w-md text-[0.8125rem] text-cloud-300">{row.decision ?? "—"}</Td>
                  <Td>{row.status === "retired" ? <RollbackButton id={row.id} version={row.version} /> : null}</Td>
                </Tr>
              );
            })}
          </TableShell>
        )}
      </Panel>

      <Panel title="Training history" description="Every run, promotion, rollback, skip and error, newest first.">
        {events.length === 0 ? (
          <NoRows>Nothing has run yet. The first nightly run is recorded here, including a run skipped for lack of labels.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>When</Th>
                <Th>Event</Th>
                <Th>Started by</Th>
                <Th>Detail</Th>
              </>
            }
          >
            {events.map((e) => {
              const ev = EVENT[e.event] ?? EVENT.skipped!;
              return (
                <Tr key={e.id}>
                  <Td mono>{formatDateTime(e.created_at)}</Td>
                  <Td>
                    <Badge tone={ev.tone}>{ev.label}</Badge>
                  </Td>
                  <Td>{e.actor ?? (e.trigger === "nightly" ? "Nightly schedule" : e.trigger === "cron" ? "Scheduler" : e.trigger)}</Td>
                  <Td className={`max-w-xl text-[0.8125rem] ${e.event === "failed" ? "text-rose-400" : "text-cloud-300"}`}>{e.detail}</Td>
                </Tr>
              );
            })}
          </TableShell>
        )}
      </Panel>

      <Panel
        title="Feedback"
        description={`"Did AdSense approve your site?" is asked 14 days after a scan, on the dashboard and by one email. ${feedback.open} open · ${feedback.answered} answered · ${feedback.emailsSent} emails sent${feedback.emailsFailed ? ` · ${feedback.emailsFailed} failed` : ""}.`}
      >
        {answers.length === 0 ? (
          <NoRows>No answers yet.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>When</Th>
                <Th>Site</Th>
                <Th>Answer</Th>
                <Th>Result</Th>
                <Th>Why</Th>
              </>
            }
          >
            {answers.map((a) => (
              <Tr key={a.id}>
                <Td mono>{formatDateTime(a.created_at)}</Td>
                <Td>{a.domain}</Td>
                <Td>
                  {OUTCOME[a.outcome] ?? a.outcome}
                  {a.outcome === "rejected" ? <p className="text-[0.8125rem] text-cloud-400">{rejectionReasonLabel(a.rejection_reason)}</p> : null}
                </Td>
                <Td>
                  <Badge tone={FEEDBACK_STATUS[a.status] ?? "neutral"}>{a.status}</Badge>
                </Td>
                <Td className="max-w-md text-[0.8125rem] text-cloud-300">{a.status_reason}</Td>
              </Tr>
            ))}
          </TableShell>
        )}
      </Panel>

      <div className="space-y-2 text-[0.875rem] leading-relaxed text-cloud-400">
        <p className="flex gap-2">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {MODEL_LIMITATIONS}
        </p>
        <p className="flex gap-2">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          Label trust: answers from accounts under 3 days old wait; opposite answers for the same site from different accounts within 30 days count half each; an account giving more than 20 answers in 30 days is scaled down. {stats.reduced ? `${stats.reduced} label${stats.reduced === 1 ? "" : "s"} currently count${stats.reduced === 1 ? "s" : ""} for less.` : ""}
        </p>
      </div>
    </div>
  );
}
