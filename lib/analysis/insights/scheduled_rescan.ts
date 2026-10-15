import { formatDate } from "@/lib/format";
import { getSchedule, WEEK_MS } from "@/lib/schedules/store";

import type { InsightDef } from "./contract";

/**
 * Feature 53 — weekly rescans: the report line shows whether this site is
 * on a weekly schedule, when it runs next, and why it is paused or off.
 * The schedule itself is set from the report page and run by
 * lib/schedules/job.ts.
 */
export const insight: InsightDef = {
  key: "scheduled_rescan",
  name: "Weekly rescans",
  category: "smart",
  scope: "site",
  defaultPlan: "pro",
  run({ userId, domain, demo, now }) {
    if (demo) {
      return { status: "pass", summary: "Sample report: weekly rescans apply to live scans only.", findings: [], recommendation: "", confidence: "high" };
    }
    const schedule = getSchedule(userId, domain);
    if (!schedule || !schedule.enabled) {
      return {
        status: "warn",
        summary: "Weekly rescans are off for this site.",
        findings: schedule?.stateReason ? [{ message: schedule.stateReason }] : [],
        recommendation: "Turn on weekly rescans at the top of this report to have the site checked every week and be emailed when findings change.",
        confidence: "high",
      };
    }
    if (schedule.state === "paused") {
      return {
        status: "warn",
        summary: `Weekly rescans are paused. ${schedule.stateReason ?? ""}`.trim(),
        findings: [{ message: `Next check: ${formatDate(schedule.nextRunAt)}.` }],
        recommendation: "Rescans resume by themselves once the reason above no longer applies.",
        confidence: "high",
      };
    }
    // During a scheduled run the stored time is the run now under way; show the one after it.
    let next = schedule.nextRunAt;
    while (next <= now) next += WEEK_MS;
    return {
      status: "pass",
      summary: `Weekly rescans are on — next scan around ${formatDate(next)}. You'll be emailed when findings change.`,
      findings: schedule.stateReason ? [{ message: schedule.stateReason }] : [],
      recommendation: "",
      confidence: "high",
    };
  },
};
