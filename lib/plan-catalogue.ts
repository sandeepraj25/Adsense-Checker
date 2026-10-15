import { bit, many, one, run } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import {
  MAX_PAGES_PER_SCAN,
  FEATURE_KEYS,
  PLANS,
  PLAN_ORDER,
  isFeatureKey,
  isPlanId,
  type FeatureKey,
  type Plan,
  type PlanId,
} from "@/lib/plans";

/**
 * ────────────────────────────────────────────────────────────────
 *  THE RUNTIME PLAN CATALOGUE
 * ────────────────────────────────────────────────────────────────
 *  One place answers "what does this plan cost and allow", and it is
 *  this module. Prices and limits live in the `plans` table so an admin
 *  can change them; lib/plans.ts supplies the shipped defaults that seed
 *  that table and stand in if a row is missing.
 *
 *  Nothing else in the app should read `PLANS` directly to make a
 *  decision about money or entitlement — a hardcoded ₹399 in a route
 *  handler is exactly how an admin's price change turns into a customer
 *  charged one amount and credited another. Read `getPlan()` here.
 *
 *  Consequence worth stating: once a row exists, editing the default in
 *  lib/plans.ts no longer changes a running install. That is the price of
 *  letting an admin edit at all, and the right way round — the operator's
 *  deliberate change must not be silently reverted by a deploy.
 */

type PlanRow = {
  id: string;
  name: string;
  tagline: string;
  amount_paise: number;
  currency: string;
  /** Added in schema v6. NULL = not offered in USD. */
  usd_amount_cents?: number | null;
  /** Added in schema v14. NULL = not offered yearly in that currency. */
  yearly_amount_paise?: number | null;
  yearly_usd_cents?: number | null;
  yearly_enabled?: number;
  yearly_badge?: string | null;
  billing_interval: string;
  site_limit: number;
  scan_limit: number;
  /** Added in schema v15. NULL on a row nothing has set: the shipped default applies. */
  pages_per_scan?: number | null;
  purchasable: number;
  featured: number;
  active: number;
  features_json: string;
  showcase_json: string;
  excluded_json: string;
  highlights_json: string;
  sort_order: number;
  updated_at: number;
  updated_by: string | null;
};

/** A plan plus who last touched it. The admin table wants both. */
export type PlanRecord = Plan & {
  updatedAt: number;
  updatedBy: string | null;
};

/* ── reading ─────────────────────────────────────────────────────── */

function featureList(json: string): FeatureKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // An unknown key in the database is dropped rather than trusted: a
  // feature name that no longer exists in code has nothing enforcing it,
  // so keeping it would put an unbacked line on a pricing card.
  const seen = new Set<FeatureKey>();
  for (const value of parsed) if (isFeatureKey(value)) seen.add(value);
  return [...seen];
}

function stringList(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function toPlan(row: PlanRow): PlanRecord | null {
  if (!isPlanId(row.id)) return null; // a plan with no code behind it
  const shipped = PLANS[row.id];
  return {
    id: row.id,
    name: row.name || shipped.name,
    tagline: row.tagline,
    amountPaise: row.amount_paise,
    currency: "INR",
    usdAmountCents: row.id === "free" ? 0 : (row.usd_amount_cents ?? null),
    yearlyAmountPaise: row.id === "free" ? null : (row.yearly_amount_paise ?? null),
    yearlyUsdCents: row.id === "free" ? null : (row.yearly_usd_cents ?? null),
    yearlyEnabled: row.id !== "free" && row.yearly_enabled === 1,
    yearlyBadge: row.yearly_badge?.trim() || null,
    interval: "month",
    siteLimit: row.site_limit,
    scanLimit: row.scan_limit,
    pagesPerScan: row.pages_per_scan && row.pages_per_scan > 0 ? row.pages_per_scan : shipped.pagesPerScan,
    purchasable: row.purchasable === 1,
    featured: row.featured === 1,
    active: row.active === 1,
    features: featureList(row.features_json),
    showcase: featureList(row.showcase_json),
    excluded: featureList(row.excluded_json),
    highlights: stringList(row.highlights_json),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function shippedRecord(id: PlanId): PlanRecord {
  return { ...PLANS[id], updatedAt: 0, updatedBy: null };
}

/**
 * Every plan, in display order, whether active or not.
 *
 * Falls back to the shipped defaults for anything the table is missing,
 * so a half-migrated or hand-edited database still renders a coherent
 * pricing page instead of an empty one.
 */
export function listPlans(): PlanRecord[] {
  const rows = many<PlanRow>("SELECT * FROM plans ORDER BY sort_order ASC");
  const byId = new Map<PlanId, PlanRecord>();
  for (const row of rows) {
    const plan = toPlan(row);
    if (plan) byId.set(plan.id, plan);
  }
  return PLAN_ORDER.map((id) => byId.get(id) ?? shippedRecord(id));
}

/** Plans an admin has left switched on. What the pricing page shows. */
export function listActivePlans(): PlanRecord[] {
  return listPlans().filter((plan) => plan.active);
}

/** Active plans that can actually be bought. Free is granted, not sold. */
export function listPurchasablePlans(): PlanRecord[] {
  return listActivePlans().filter((plan) => plan.purchasable);
}

/**
 * The live definition of one plan, or null for an id we do not ship.
 *
 * Never throws and never invents a plan: an unknown id is a bug or a
 * tampered request, and both want a rejection rather than a default.
 */
export function getPlan(id: unknown): PlanRecord | null {
  if (!isPlanId(id)) return null;
  const row = one<PlanRow>("SELECT * FROM plans WHERE id = ?", [id]);
  return (row && toPlan(row)) ?? shippedRecord(id);
}

/** For paths that already know the id is valid. */
export function requirePlan(id: PlanId): PlanRecord {
  return getPlan(id) ?? shippedRecord(id);
}

/** Does this plan, as currently configured, include the feature? */
export function planHasFeature(plan: Plan, feature: FeatureKey): boolean {
  return plan.features.includes(feature);
}

/**
 * The cheapest active plan that currently includes a feature.
 *
 * Read from the catalogue rather than from FEATURE_META, because an admin
 * who moved AI checking onto Pro only must not leave the app telling
 * people to buy Basic for it.
 */
export function cheapestPlanWith(feature: FeatureKey): PlanRecord | null {
  const candidates = listActivePlans()
    .filter((plan) => plan.features.includes(feature))
    .sort((a, b) => a.amountPaise - b.amountPaise);
  return candidates[0] ?? null;
}

/* ── writing ─────────────────────────────────────────────────────── */

export type PlanPatch = {
  name?: string;
  tagline?: string;
  amountPaise?: number;
  /** null withdraws the plan from USD checkout. */
  usdAmountCents?: number | null;
  /** null withdraws the yearly price in that currency. */
  yearlyAmountPaise?: number | null;
  yearlyUsdCents?: number | null;
  yearlyEnabled?: boolean;
  /** "" or null removes the badge. */
  yearlyBadge?: string | null;
  siteLimit?: number;
  scanLimit?: number;
  pagesPerScan?: number;
  purchasable?: boolean;
  featured?: boolean;
  active?: boolean;
  features?: FeatureKey[];
  showcase?: FeatureKey[];
  excluded?: FeatureKey[];
  highlights?: string[];
};

export type PlanUpdateResult =
  | { ok: true; before: PlanRecord; after: PlanRecord; changed: string[] }
  | { ok: false; error: string };

const MAX_PRICE_PAISE = 100_000_00; // ₹100,000 — a typo guard, not a policy
const MAX_PRICE_CENTS = 10_000_00; // $10,000 — the same guard in dollars

function invalid(patch: PlanPatch, id: PlanId): string | null {
  if (patch.amountPaise !== undefined) {
    if (!Number.isInteger(patch.amountPaise) || patch.amountPaise < 0) {
      return "Price must be a whole number of paise, zero or more.";
    }
    if (patch.amountPaise > MAX_PRICE_PAISE) {
      return "That price looks like a mistake. Enter the amount in paise (₹399 is 39900).";
    }
    // The free tier is the product's entry point and several flows grant
    // it without a payment. A priced "free" plan would hand out paid
    // access for nothing, so the floor is fixed here rather than trusted
    // to the form.
    if (id === "free" && patch.amountPaise !== 0) {
      return "The Free plan must stay at ₹0.";
    }
  }
  if (patch.usdAmountCents !== undefined && patch.usdAmountCents !== null) {
    if (!Number.isInteger(patch.usdAmountCents) || patch.usdAmountCents < 0) {
      return "The USD price must be zero or more, with at most two decimals.";
    }
    if (patch.usdAmountCents > MAX_PRICE_CENTS) {
      return "That USD price looks like a mistake — it is over $10,000 a month.";
    }
  }
  if (id === "free" && patch.usdAmountCents !== undefined && patch.usdAmountCents !== 0) {
    return "The Free plan must stay at $0.";
  }
  if (id !== "free" && patch.amountPaise === 0) {
    return "A paid plan needs an INR price above ₹0. Make it unpurchasable instead.";
  }
  if (id !== "free" && patch.usdAmountCents === 0) {
    return "A paid plan can't be $0. Leave the USD price empty to stop offering it in dollars.";
  }
  for (const [key, max, label] of [
    ["yearlyAmountPaise", MAX_PRICE_PAISE * 12, "INR"],
    ["yearlyUsdCents", MAX_PRICE_CENTS * 12, "USD"],
  ] as const) {
    const value = patch[key];
    if (value === undefined || value === null) continue;
    if (id === "free") return "The Free plan has no yearly price.";
    if (!Number.isInteger(value) || value <= 0) {
      return `The yearly ${label} price must be above zero, with at most two decimals. Leave it empty to not offer yearly billing in ${label}.`;
    }
    if (value > max) return `That yearly ${label} price looks like a mistake.`;
  }
  if (patch.yearlyEnabled === true && id === "free") return "The Free plan can't be sold yearly.";
  if (patch.yearlyBadge !== undefined && patch.yearlyBadge !== null && patch.yearlyBadge.trim().length > 40) {
    return "Keep the yearly badge to 40 characters or fewer.";
  }
  if (patch.siteLimit !== undefined && (!Number.isInteger(patch.siteLimit) || patch.siteLimit < 1)) {
    return "Website limit must be at least 1.";
  }
  if (patch.scanLimit !== undefined && (!Number.isInteger(patch.scanLimit) || patch.scanLimit < 1)) {
    return "Monthly scan limit must be at least 1.";
  }
  if (
    patch.pagesPerScan !== undefined &&
    (!Number.isInteger(patch.pagesPerScan) || patch.pagesPerScan < 1 || patch.pagesPerScan > MAX_PAGES_PER_SCAN)
  ) {
    return `Pages per scan must be a whole number from 1 to ${MAX_PAGES_PER_SCAN}.`;
  }
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    return "A plan needs a name.";
  }
  for (const key of ["features", "showcase", "excluded"] as const) {
    const list = patch[key];
    if (list && list.some((feature) => !isFeatureKey(feature))) {
      return "Unknown feature key.";
    }
  }
  if (patch.purchasable === true && id === "free") {
    return "The Free plan is granted on signup, not sold.";
  }
  return null;
}

/**
 * Applies an admin's edit and reports what actually changed.
 *
 * Existing subscriptions are deliberately untouched. Each one snapshots
 * the price and limits it was sold at, so re-pricing a plan changes what
 * the next renewal costs and nothing about what somebody already paid —
 * rewriting live subscriptions here would quietly falsify billing history.
 */
export function updatePlan(
  id: PlanId,
  patch: PlanPatch,
  admin: { id: string; email: string },
): PlanUpdateResult {
  const before = getPlan(id);
  if (!before) return { ok: false, error: "No such plan." };

  const problem = invalid(patch, id);
  if (problem) return { ok: false, error: problem };

  const next: Plan = {
    ...before,
    name: patch.name?.trim() ?? before.name,
    tagline: patch.tagline?.trim() ?? before.tagline,
    amountPaise: patch.amountPaise ?? before.amountPaise,
    usdAmountCents:
      patch.usdAmountCents === undefined ? before.usdAmountCents : patch.usdAmountCents,
    yearlyAmountPaise: patch.yearlyAmountPaise === undefined ? before.yearlyAmountPaise : patch.yearlyAmountPaise,
    yearlyUsdCents: patch.yearlyUsdCents === undefined ? before.yearlyUsdCents : patch.yearlyUsdCents,
    yearlyEnabled: patch.yearlyEnabled ?? before.yearlyEnabled,
    yearlyBadge: patch.yearlyBadge === undefined ? before.yearlyBadge : patch.yearlyBadge?.trim() || null,
    siteLimit: patch.siteLimit ?? before.siteLimit,
    scanLimit: patch.scanLimit ?? before.scanLimit,
    pagesPerScan: patch.pagesPerScan ?? before.pagesPerScan,
    purchasable: patch.purchasable ?? before.purchasable,
    featured: patch.featured ?? before.featured,
    active: patch.active ?? before.active,
    features: patch.features ?? before.features,
    showcase: patch.showcase ?? before.showcase,
    excluded: patch.excluded ?? before.excluded,
    highlights: patch.highlights ?? before.highlights,
  };

  // A card cannot advertise what the plan does not include, and cannot
  // list a feature as missing that it does include. Both would be visible
  // to a customer as a contradiction, so they are reconciled here rather
  // than left to whoever wrote the form.
  next.showcase = next.showcase.filter((feature) => next.features.includes(feature));
  next.excluded = next.excluded.filter((feature) => !next.features.includes(feature));

  const changed = describeChanges(before, next);
  if (changed.length === 0) {
    return { ok: true, before, after: before, changed: [] };
  }

  const now = Date.now();
  run(
    `UPDATE plans
        SET name = ?, tagline = ?, amount_paise = ?, usd_amount_cents = ?,
            yearly_amount_paise = ?, yearly_usd_cents = ?, yearly_enabled = ?, yearly_badge = ?, site_limit = ?,
            scan_limit = ?, pages_per_scan = ?, purchasable = ?, featured = ?, active = ?,
            features_json = ?, showcase_json = ?, excluded_json = ?,
            highlights_json = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
    [
      next.name,
      next.tagline,
      next.amountPaise,
      next.id === "free" ? 0 : next.usdAmountCents,
      next.id === "free" ? null : next.yearlyAmountPaise,
      next.id === "free" ? null : next.yearlyUsdCents,
      bit(next.id !== "free" && next.yearlyEnabled),
      next.yearlyBadge,
      next.siteLimit,
      next.scanLimit,
      next.pagesPerScan,
      bit(next.purchasable),
      bit(next.featured),
      bit(next.active),
      JSON.stringify(next.features),
      JSON.stringify(next.showcase),
      JSON.stringify(next.excluded),
      JSON.stringify(next.highlights),
      now,
      admin.email,
      id,
    ],
  );

  // Exactly one card carries the emphasis. Promoting one demotes the rest.
  if (next.featured && !before.featured) {
    run("UPDATE plans SET featured = 0 WHERE id <> ?", [id]);
  }

  return { ok: true, before, after: requirePlan(id), changed };
}

/** Human-readable diff, written into the admin audit log. */
export function describeChanges(before: Plan, after: Plan): string[] {
  const notes: string[] = [];
  const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

  if (before.name !== after.name) notes.push(`name ${before.name} → ${after.name}`);
  if (before.tagline !== after.tagline) notes.push("tagline edited");
  if (before.amountPaise !== after.amountPaise) {
    notes.push(`price ${rupees(before.amountPaise)} → ${rupees(after.amountPaise)} / month`);
  }
  if (before.usdAmountCents !== after.usdAmountCents) {
    const usd = (cents: number | null) => (cents === null ? "not offered" : formatMoney(cents, "USD"));
    notes.push(`USD price ${usd(before.usdAmountCents)} → ${usd(after.usdAmountCents)} / month`);
  }
  const yearly = (minor: number | null, currency: "INR" | "USD") => (minor === null ? "not offered" : formatMoney(minor, currency));
  if (before.yearlyAmountPaise !== after.yearlyAmountPaise) {
    notes.push(`yearly INR price ${yearly(before.yearlyAmountPaise, "INR")} → ${yearly(after.yearlyAmountPaise, "INR")} / year`);
  }
  if (before.yearlyUsdCents !== after.yearlyUsdCents) {
    notes.push(`yearly USD price ${yearly(before.yearlyUsdCents, "USD")} → ${yearly(after.yearlyUsdCents, "USD")} / year`);
  }
  if (before.yearlyEnabled !== after.yearlyEnabled) notes.push(after.yearlyEnabled ? "yearly billing on" : "yearly billing off");
  if (before.yearlyBadge !== after.yearlyBadge) notes.push(`yearly badge ${after.yearlyBadge ? `"${after.yearlyBadge}"` : "removed"}`);
  if (before.siteLimit !== after.siteLimit) {
    notes.push(`websites ${before.siteLimit} → ${after.siteLimit}`);
  }
  if (before.scanLimit !== after.scanLimit) {
    notes.push(`scans/month ${before.scanLimit} → ${after.scanLimit}`);
  }
  if (before.pagesPerScan !== after.pagesPerScan) {
    notes.push(`pages/scan ${before.pagesPerScan} → ${after.pagesPerScan}`);
  }
  if (before.purchasable !== after.purchasable) {
    notes.push(after.purchasable ? "made purchasable" : "made unpurchasable");
  }
  if (before.featured !== after.featured) {
    notes.push(after.featured ? "highlighted" : "un-highlighted");
  }
  if (before.active !== after.active) {
    notes.push(after.active ? "activated" : "deactivated");
  }

  const added = after.features.filter((f) => !before.features.includes(f));
  const removed = before.features.filter((f) => !after.features.includes(f));
  if (added.length) notes.push(`enabled ${added.join(", ")}`);
  if (removed.length) notes.push(`disabled ${removed.join(", ")}`);

  if (JSON.stringify(before.highlights) !== JSON.stringify(after.highlights)) {
    notes.push("highlights edited");
  }
  return notes;
}

/**
 * Restores one plan to the shipped defaults. The panel's escape hatch.
 *
 * The USD price is left alone: the shipped defaults have none, and a
 * reset meant to undo a feature or limit edit must not quietly withdraw a
 * plan from dollar checkout. Prices are managed on Admin → Pricing.
 */
export function resetPlan(
  id: PlanId,
  admin: { id: string; email: string },
): PlanUpdateResult {
  const shipped = PLANS[id];
  return updatePlan(
    id,
    {
      name: shipped.name,
      tagline: shipped.tagline,
      amountPaise: shipped.amountPaise,
      siteLimit: shipped.siteLimit,
      scanLimit: shipped.scanLimit,
      pagesPerScan: shipped.pagesPerScan,
      purchasable: shipped.purchasable,
      featured: shipped.featured,
      active: shipped.active,
      features: [...shipped.features],
      showcase: [...shipped.showcase],
      excluded: [...shipped.excluded],
      highlights: [...shipped.highlights],
    },
    admin,
  );
}

/** Every feature key, for the admin's per-plan toggle grid. */
export const ALL_FEATURES: readonly FeatureKey[] = FEATURE_KEYS;
