import { runAlertJobThrottled } from "./lib/alerts/job";
import { runMlJobThrottled } from "./lib/ml/job";
import { runScheduledRescansThrottled } from "./lib/schedules/job";

/**
 * A light background tick for payment/checkout alerts on the long-running
 * Node server. It is a safety net, not the schedule of record: the
 * recommended trigger is a scheduler calling
 * POST /api/internal/jobs/checkout-alerts (see README). Both are safe
 * together — claims and alerts are de-duplicated in the database — and a
 * restart loses nothing, because all state lives in the database.
 *
 * Set CHECKOUT_ALERTS_BACKGROUND=off to disable it.
 */
const disabled = process.env.CHECKOUT_ALERTS_BACKGROUND?.trim().toLowerCase() === "off";
const building = process.env.NEXT_PHASE === "phase-production-build";

if (!disabled && !building) {
  const timer = setInterval(() => {
    void runAlertJobThrottled(4 * 60_000);
  }, 5 * 60_000);
  timer.unref?.();
}

/**
 * The prediction system's tick (lib/ml/job.ts): deferred feedback,
 * feedback emails, and nightly retraining. Like the alerts tick it is a
 * safety net beside POST /api/internal/jobs/ml; every step is claimed in
 * the database, so running both is harmless.
 *
 * Set ML_BACKGROUND=off to disable it.
 */
const mlDisabled = process.env.ML_BACKGROUND?.trim().toLowerCase() === "off";

if (!mlDisabled && !building) {
  const mlTimer = setInterval(() => {
    void runMlJobThrottled(4 * 60_000);
  }, 5 * 60_000);
  mlTimer.unref?.();
}

/**
 * Weekly rescans (lib/schedules/job.ts): runs due rescans and sends change
 * emails. A safety net beside POST /api/internal/jobs/rescans; schedules
 * are claimed in the database, so running both never doubles a scan.
 *
 * Set RESCANS_BACKGROUND=off to disable it.
 */
const rescansDisabled = process.env.RESCANS_BACKGROUND?.trim().toLowerCase() === "off";

if (!rescansDisabled && !building) {
  const rescanTimer = setInterval(() => {
    void runScheduledRescansThrottled(4 * 60_000);
  }, 5 * 60_000);
  rescanTimer.unref?.();
}
