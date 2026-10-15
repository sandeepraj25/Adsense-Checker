import type { Subscription } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { getPlan } from "@/lib/plan-catalogue";
import { MAX_PAGES_PER_SCAN, PLANS, isPlanId } from "@/lib/plans";

/**
 * Usage limits (Phase 5), in one place.
 *
 *   scans per month   subscriptions.scan_limit — the existing allowance,
 *                     claimed atomically by consumeScan and reset every
 *                     calendar month (yearly plans too).
 *   pages per scan    subscriptions.page_limit, snapshotted from the plan;
 *                     for older rows without it, the plan's current value;
 *                     for a plan without one, the shipped default. Always
 *                     between 1 and MAX_PAGES_PER_SCAN.
 *
 * What a scan costs:
 *   refused before it starts (bad address, no plan, out of scans, a scan
 *   of the site already running, too many running) → nothing;
 *   failed on our side or the site unreachable → refunded;
 *   finished, even if cut short by the time limit → one scan.
 */

export function pagesPerScanFor(subscription: Pick<Subscription, "planId" | "pageLimit">): number {
  const fromRow = subscription.pageLimit;
  const fromPlan = getPlan(subscription.planId)?.pagesPerScan;
  const shipped = isPlanId(subscription.planId) ? PLANS[subscription.planId].pagesPerScan : 1;
  const value = fromRow ?? fromPlan ?? shipped;
  return Math.max(1, Math.min(MAX_PAGES_PER_SCAN, Math.floor(value)));
}

/** Most scans one account may have running at once. */
export const MAX_RUNNING_SCANS_PER_ACCOUNT = 2;

/** What someone out of scans is told — by the API, the checker and rescans. */
export function limitReachedMessage(subscription: Pick<Subscription, "scanLimit" | "planName" | "cycleEnd">): string {
  const n = subscription.scanLimit;
  return `Monthly scan limit reached. You've used all ${n} scan${n === 1 ? "" : "s"} on the ${subscription.planName} plan this month; your allowance resets on ${formatDate(subscription.cycleEnd)}. Upgrade your plan to scan again sooner.`;
}
