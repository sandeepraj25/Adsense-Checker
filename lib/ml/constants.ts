/**
 * Shared, browser-safe constants for the prediction system. No imports
 * from the server, so client components can use the labels too.
 */

/** Usable labelled examples needed before a trained model may be used. */
export const MIN_LABELED_EXAMPLES = 200;
/** Each outcome must have at least this many examples as well. */
export const MIN_PER_CLASS = 30;
/** Days after a completed scan before we ask how the application went. */
export const FEEDBACK_DELAY_DAYS = 14;
/** Feedback from an account younger than this is deferred, not used yet. */
export const MIN_ACCOUNT_AGE_DAYS = 3;
/** "Not applied yet" asks again later, at most this many times in total. */
export const MAX_ASKS = 3;

/**
 * The rejection reasons a person can pick. Fixed categories, not free
 * text — they are what the reason model learns, and free text would
 * invite personal details into the training data.
 */
export const REJECTION_REASONS = [
  { id: "low_value_content", label: "Low value content" },
  { id: "insufficient_content", label: "Insufficient or thin content" },
  { id: "policy_violation", label: "Policy violation (prohibited content)" },
  { id: "navigation", label: "Site navigation or design problems" },
  { id: "site_unavailable", label: "Site down or unavailable" },
  { id: "copied_content", label: "Copied or scraped content" },
  { id: "under_construction", label: "Under construction / not ready" },
  { id: "invalid_traffic", label: "Invalid traffic" },
  { id: "other", label: "Other or not stated" },
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number]["id"];

export function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === "string" && REJECTION_REASONS.some((r) => r.id === value);
}

export function rejectionReasonLabel(id: string | null | undefined): string {
  return REJECTION_REASONS.find((r) => r.id === id)?.label ?? "Not given";
}

/** What every estimate must say about itself. */
export const MODEL_LIMITATIONS =
  "This estimate is learned from outcomes other site owners reported for sites with similar scan results. It does not reproduce Google's internal review, does not guarantee approval, and a factor's weight shows association, not cause.";

export const RULE_LIMITATIONS =
  "Estimated (rule-based): a readiness index computed from this scan's own scores with fixed, published weights. It is not a trained prediction and not a probability of approval.";
