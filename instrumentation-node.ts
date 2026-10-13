import { runAlertJobThrottled } from "./lib/alerts/job";

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
