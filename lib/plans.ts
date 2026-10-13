/**
 * ────────────────────────────────────────────────────────────────
 *  SINGLE SOURCE OF TRUTH FOR PRICING AND ENTITLEMENTS
 * ────────────────────────────────────────────────────────────────
 *  Three monthly plans. Nothing here is a lifetime purchase: every
 *  allowance is per billing month and resets on the renewal date.
 *
 *  This file is the seed and the fallback. Admins can re-price plans
 *  and toggle features at runtime (see lib/plan-catalogue.ts), and
 *  those overrides live in the `plans` table — but the shape, the
 *  feature vocabulary, and the shipped defaults are defined here so a
 *  fresh database and an empty admin panel still produce a correct
 *  product.
 *
 *  `amountPaise` is authoritative and always in the smallest currency
 *  unit, because that is what a gateway charges (₹399 => 39900).
 *  Never store rupees as a float.
 *
 *  Two rules to keep in mind when editing:
 *
 *  1. A feature listed on a plan must be *enforced* somewhere. The
 *     mapping from feature to work is in lib/analysis/checks.ts and
 *     lib/analysis/engine.ts. A card line with nothing behind it is a
 *     lie told at the till.
 *  2. Higher tiers are cumulative. Pro's card only lists what Pro adds,
 *     but `features` below is the full effective set, because that is
 *     what the gate reads.
 */

export type PlanId = "free" | "basic" | "pro";

export type BillingInterval = "month";

/* ── the feature vocabulary ──────────────────────────────────────── */

export const FEATURE_KEYS = [
  "basic_page_check",
  "https_check",
  "advanced_page_check",
  "ai_content_check",
  "originality_check",
  "duplicate_content_check",
  "adsense_policy_check",
  "deep_ai_page_check",
  "ai_human_content_check",
  "page_by_page_analysis",
  "site_structure_analysis",
  "crawlability_check",
  "sitemap_analysis",
  "robots_check",
  "ad_density_analysis",
  "policy_risk_detection",
  "ai_recommendations",
  "priority_support",
  "pdf_export",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * What each feature is called and what it actually does.
 *
 * `does` is shown in upgrade prompts and in the report where a section
 * is locked. It has to describe real work, so if you add a key here you
 * are promising to implement it.
 */
export const FEATURE_META: Record<
  FeatureKey,
  { label: string; does: string; minPlan: PlanId }
> = {
  basic_page_check: {
    label: "Basic page check",
    does: "Reads your homepage and checks titles, headings, navigation, response status and page weight.",
    minPlan: "free",
  },
  https_check: {
    label: "HTTPS check",
    does: "Confirms the site is served over HTTPS and that the plain-HTTP address redirects to it.",
    minPlan: "free",
  },
  advanced_page_check: {
    label: "Advanced page check",
    does: "Adds meta descriptions, canonical tags, indexability directives, social tags, image alt text, mobile viewport behaviour, broken internal links and response timing.",
    minPlan: "basic",
  },
  ai_content_check: {
    label: "AI content check",
    does: "Estimates how machine-written your pages read, from sentence uniformity, connective density and vocabulary spread. An estimate, not a determination.",
    minPlan: "basic",
  },
  originality_check: {
    label: "Content originality check",
    does: "Looks for boilerplate, template filler, stock phrasing and syndication markers that suggest the text was not written for this site.",
    minPlan: "basic",
  },
  duplicate_content_check: {
    label: "Duplicate content check",
    does: "Compares every page we read against every other, by overlapping word sequences, and reports pages that are duplicates or near-duplicates.",
    minPlan: "basic",
  },
  adsense_policy_check: {
    label: "AdSense policy check",
    does: "Checks the pages a reviewer looks for — privacy policy, contact, about, terms — and scans your copy for content in restricted categories.",
    minPlan: "basic",
  },
  deep_ai_page_check: {
    label: "Deep AI page check",
    does: "Runs the content signals on every page we crawl rather than the homepage alone, and widens the crawl to reach them.",
    minPlan: "pro",
  },
  ai_human_content_check: {
    label: "Advanced AI + human content check",
    does: "Combines the machine-written estimate with human-authorship signals: bylines, dates, first-person voice and editorial structure.",
    minPlan: "pro",
  },
  page_by_page_analysis: {
    label: "Page-by-page analysis",
    does: "Scores each crawled page on its own and lists them so you can see which specific pages are dragging the site down.",
    minPlan: "pro",
  },
  site_structure_analysis: {
    label: "Website structure analysis",
    does: "Maps directory depth, orphan pages, internal link distribution and section breadth across the pages we reach.",
    minPlan: "pro",
  },
  crawlability_check: {
    label: "Crawlability / indexability check",
    does: "Checks that Googlebot and the AdSense crawler are allowed in, and that your pages are not excluded by noindex, canonical or robots rules.",
    minPlan: "pro",
  },
  sitemap_analysis: {
    label: "Sitemap analysis",
    does: "Fetches and parses your sitemap, counts the URLs, checks they are on your own domain and samples them for reachability.",
    minPlan: "pro",
  },
  robots_check: {
    label: "robots.txt check",
    does: "Fetches and parses robots.txt, resolves the rules that apply to each crawler, and reports anything that blocks review.",
    minPlan: "pro",
  },
  ad_density_analysis: {
    label: "Ad density analysis",
    does: "Counts existing ad slots and iframes against the amount of real content on each page, and checks ads.txt.",
    minPlan: "pro",
  },
  policy_risk_detection: {
    label: "Policy risk detection",
    does: "Grades the findings that most often trigger a rejection into a ranked risk list, so you know what to fix first.",
    minPlan: "pro",
  },
  ai_recommendations: {
    label: "Detailed AI recommendations",
    does: "Turns the findings into an ordered remediation plan with a specific action written for your site.",
    minPlan: "pro",
  },
  priority_support: {
    label: "Priority support",
    does: "Your support requests are queued ahead of free and Basic accounts.",
    minPlan: "pro",
  },
  pdf_export: {
    label: "Export PDF reports",
    does: "Exports any report as a paginated PDF with the score, category breakdown, findings and recommendations.",
    minPlan: "pro",
  },
};

/* ── the plans ───────────────────────────────────────────────────── */

const FREE_FEATURES: FeatureKey[] = ["basic_page_check", "https_check"];

const BASIC_FEATURES: FeatureKey[] = [
  ...FREE_FEATURES,
  "advanced_page_check",
  "ai_content_check",
  "originality_check",
  "duplicate_content_check",
  "adsense_policy_check",
];

const PRO_FEATURES: FeatureKey[] = [
  ...BASIC_FEATURES,
  "deep_ai_page_check",
  "ai_human_content_check",
  "page_by_page_analysis",
  "site_structure_analysis",
  "crawlability_check",
  "sitemap_analysis",
  "robots_check",
  "ad_density_analysis",
  "policy_risk_detection",
  "ai_recommendations",
  "priority_support",
  "pdf_export",
];

export type Plan = {
  id: PlanId;
  name: string;
  tagline: string;
  /** Authoritative INR price in paise, per interval. 39900 === ₹399. */
  amountPaise: number;
  /** The currency `amountPaise` is in. Always INR. */
  currency: "INR";
  /**
   * Independent USD price in cents, or null when the plan is not offered
   * in dollars. Never derived from the INR price — an admin sets it.
   */
  usdAmountCents: number | null;
  interval: BillingInterval;
  /** Distinct websites the account may hold at once. */
  siteLimit: number;
  /** Article scans granted per billing month. Resets on renewal. */
  scanLimit: number;
  /** Can this be bought? `free` is granted on signup, never sold. */
  purchasable: boolean;
  /** Renders the emphasised card. Exactly one should be true. */
  featured: boolean;
  /** Offered on the pricing page at all. */
  active: boolean;
  /** The full effective feature set. Cumulative up the tiers. */
  features: FeatureKey[];
  /**
   * The card's own lines, in the order they should read. Higher tiers
   * list only what they add — "everything in Basic" carries the rest.
   */
  showcase: FeatureKey[];
  /** Features worth naming as *absent*, so the limit is not a surprise. */
  excluded: FeatureKey[];
  /** Lines above the feature list. Limits, in words. */
  highlights: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Enough to see where your site stands.",
    amountPaise: 0,
    currency: "INR",
    usdAmountCents: 0,
    interval: "month",
    siteLimit: 1,
    scanLimit: 10,
    purchasable: false,
    featured: false,
    active: true,
    features: FREE_FEATURES,
    showcase: FREE_FEATURES,
    excluded: ["ai_content_check"],
    highlights: ["1 website", "10 article scans per month"],
  },

  basic: {
    id: "basic",
    name: "Basic",
    tagline: "For a site you are getting ready to submit.",
    amountPaise: 39900,
    currency: "INR",
    // Not offered in dollars until an admin sets a dollar price.
    usdAmountCents: null,
    interval: "month",
    siteLimit: 3,
    scanLimit: 100,
    purchasable: true,
    featured: true,
    active: true,
    features: BASIC_FEATURES,
    showcase: [
      "advanced_page_check",
      "ai_content_check",
      "originality_check",
      "duplicate_content_check",
      "adsense_policy_check",
    ],
    excluded: ["pdf_export"],
    highlights: ["3 websites", "100 article scans per month"],
  },

  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For publishers running several properties at once.",
    amountPaise: 99900,
    currency: "INR",
    usdAmountCents: null,
    interval: "month",
    siteLimit: 8,
    scanLimit: 300,
    purchasable: true,
    featured: false,
    active: true,
    features: PRO_FEATURES,
    showcase: [
      "deep_ai_page_check",
      "ai_human_content_check",
      "page_by_page_analysis",
      "site_structure_analysis",
      "crawlability_check",
      "sitemap_analysis",
      "robots_check",
      "ad_density_analysis",
      "policy_risk_detection",
      "ai_recommendations",
      "priority_support",
      "pdf_export",
    ],
    excluded: [],
    highlights: ["8 websites", "300 article scans per month"],
  },
};

/**
 * What a plan costs in one currency, in minor units — or null when the
 * plan has no price in that currency. The only way the app should ask.
 * Free is free everywhere.
 */
export function planPrice(
  plan: Pick<Plan, "id" | "amountPaise" | "usdAmountCents">,
  currency: string,
): number | null {
  if (plan.id === "free") return 0;
  if (currency === "INR") return plan.amountPaise;
  if (currency === "USD") return plan.usdAmountCents;
  return null;
}

/** Display order for the pricing page. */
export const PLAN_ORDER: PlanId[] = ["free", "basic", "pro"];

export const PLAN_LIST: Plan[] = PLAN_ORDER.map((id) => PLANS[id]);

export const PURCHASABLE_PLANS: Plan[] = PLAN_LIST.filter((plan) => plan.purchasable);

/** The plan every new account starts on. */
export const DEFAULT_PLAN_ID: PlanId = "free";

/** Days in a billing month. Every plan renews on this cadence. */
export const BILLING_PERIOD_DAYS = 30;

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/** Returns the shipped plan, or null for an unknown id. Never throws. */
export function getPlan(id: unknown): Plan | null {
  return isPlanId(id) ? PLANS[id] : null;
}

/** Rank for comparing tiers — higher is more capable. */
export const PLAN_RANK: Record<PlanId, number> = { free: 0, basic: 1, pro: 2 };

/** The cheapest plan that includes a feature, for upgrade prompts. */
export function planForFeature(feature: FeatureKey): Plan {
  const min = FEATURE_META[feature].minPlan;
  return PLANS[min];
}
