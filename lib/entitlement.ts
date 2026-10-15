import type { ApiErrorCode } from "@/lib/http";
import type { Subscription, User } from "@/lib/db/types";
import { cheapestPlanWith, getPlan, requirePlan } from "@/lib/plan-catalogue";
import { FEATURE_META, type FeatureKey } from "@/lib/plans";
import { sitePriceLabel } from "@/lib/site-currency";
import { limitReachedMessage } from "@/lib/limits";

/**
 * Why this account cannot do a thing right now, or null if it can.
 *
 * Both the API routes and the pages read this, so the rules cannot drift
 * between what the UI promises and what the server permits. The order
 * matters — someone should be told the most specific true thing, so "your
 * account is suspended" beats "your plan expired" beats "you are out of
 * scans".
 *
 * Nothing here is a substitute for enforcement. lib/audit-service.ts
 * claims the quota in the database, and the feature gate in the analysis
 * engine decides what actually runs. This module explains; those two
 * refuse.
 */
export type Block = {
  code: ApiErrorCode;
  message: string;
  /** Where the fix is, when there is one. */
  action?: { label: string; href: string };
};

export function accountBlock(user: Pick<User, "isBlocked" | "blockedReason"> | null): Block | null {
  if (!user?.isBlocked) return null;
  return {
    code: "ACCOUNT_BLOCKED",
    message: user.blockedReason
      ? `This account has been suspended: ${user.blockedReason} Contact support if you think this is a mistake.`
      : "This account has been suspended. Contact support if you think this is a mistake.",
  };
}

export function entitlementBlock(
  subscription: Subscription | null,
): Block | null {
  if (!subscription) {
    // The free allowance is quoted from the catalogue, never from a literal
    // here: an admin who changes the Free limit would otherwise turn this
    // sentence into a lie, and it is the first thing a new account reads.
    const free = getPlan("free");
    const freeOffer =
      free && free.active
        ? ` — the ${free.name} plan covers ${free.scanLimit} scans a month at no cost.`
        : ".";

    return {
      code: "NO_ACTIVE_PLAN",
      message: `You do not have an active plan. Choose one to start scanning${freeOffer}`,
      action: { label: "See plans", href: "/pricing" },
    };
  }

  if (subscription.isExpired || subscription.status === "expired") {
    return {
      code: "PLAN_EXPIRED",
      message: `Your ${subscription.planName} plan expired. Renew it to keep scanning — every report you have already run stays in your dashboard.`,
      action: { label: "Renew", href: "/pricing" },
    };
  }

  if (subscription.status === "cancelled") {
    return {
      code: "NO_ACTIVE_PLAN",
      message: `Your ${subscription.planName} plan was cancelled. Choose a plan to start scanning again.`,
      action: { label: "See plans", href: "/pricing" },
    };
  }

  if (subscription.scansRemaining < 1) {
    return {
      code: "LIMIT_REACHED",
      message: limitReachedMessage(subscription),
      action: { label: "Upgrade", href: "/pricing" },
    };
  }

  return null;
}

/**
 * Everything this subscription may use: what it was sold, plus anything
 * its plan has gained since.
 *
 * The union is deliberate and runs in one direction only. An admin who
 * grants PDF export to Basic should see existing Basic customers get it
 * immediately — that is the whole point of the toggle. An admin who
 * *removes* a feature must not retroactively take it away from someone
 * who is three days into a month they paid for; they lose it at renewal,
 * when the cycle re-reads the plan. Hence: snapshot is a floor, current
 * configuration is an addition, and neither is a ceiling on the other.
 */
export function effectiveFeatures(subscription: Subscription | null): FeatureKey[] {
  if (!subscription) return [];
  const current = requirePlan(subscription.planId).features;
  return [...new Set([...subscription.features, ...current])];
}

export function hasFeature(
  subscription: Subscription | null,
  feature: FeatureKey,
): boolean {
  if (!subscription) return false;
  if (!subscription.isUsable && subscription.isExpired) return false;
  return effectiveFeatures(subscription).includes(feature);
}

/**
 * The upgrade prompt for a feature this account does not have.
 *
 * Names the actual cheapest plan that includes it, read from the live
 * catalogue rather than from the shipped defaults, so the message stays
 * true after an admin moves a feature between tiers.
 */
export function featureBlock(
  subscription: Subscription | null,
  feature: FeatureKey,
): Block | null {
  if (hasFeature(subscription, feature)) return null;

  const meta = FEATURE_META[feature];
  const target = cheapestPlanWith(feature);

  if (!target) {
    return {
      code: "FEATURE_LOCKED",
      message: `${meta.label} is not available on any current plan.`,
    };
  }

  return {
    code: "FEATURE_LOCKED",
    message: (() => {
      const price = sitePriceLabel(target);
      return `${meta.label} is part of the ${target.name} plan${price ? ` (${price}/month)` : ""}. ${meta.does}`;
    })(),
    action: { label: `Upgrade to ${target.name}`, href: "/pricing" },
  };
}

/** "3 / 100 scans this month" — the string the dashboard shows. */
export function usageLabel(subscription: Subscription | null): string {
  if (!subscription) return "0 / 0";
  return `${subscription.scansUsed} / ${subscription.scanLimit}`;
}
