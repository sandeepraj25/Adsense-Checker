/**
 * The analytics vocabulary. An event whose name is not listed here is
 * refused, and each event may carry only the properties its schema names,
 * each checked against a fixed pattern. There is no free-text property,
 * so nothing a visitor types can end up in the event table.
 */

export const EVENT_NAMES = [
  "page_view",
  "session_started",
  "pricing_viewed",
  "plan_selected",
  "checkout_started",
  "checkout_details_saved",
  "payment_attempted",
  "payment_succeeded",
  "payment_failed",
  "signup_completed",
  "email_verified",
  "login_completed",
  "scan_started",
  "scan_completed",
  "scan_failed",
  "scan_blocked",
  "subscription_upgraded",
  "subscription_cancelled",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * What a browser may report. Everything else — accounts, payments,
 * scans — is recorded by the server from its own records, so a browser
 * cannot claim a purchase or a sign-up.
 */
export const CLIENT_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  "page_view",
  "pricing_viewed",
  "plan_selected",
  "checkout_started",
]);

/** Events that count as engagement for the bounce rule. page_view and session_started do not. */
export const INTERACTION_EVENTS: ReadonlySet<EventName> = new Set<EventName>(
  EVENT_NAMES.filter((name) => name !== "page_view" && name !== "session_started" && name !== "pricing_viewed"),
);

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

type PropRule = RegExp;

const PLAN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CURRENCY = /^(INR|USD)$/;
const GATEWAY = /^[a-z][a-z0-9_-]{0,23}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,39}$/;
const MODE = /^(live|mock)$/;
const KIND = /^(first|repeat)$/;

const PROPS: Record<EventName, Record<string, PropRule>> = {
  page_view: {},
  session_started: {},
  pricing_viewed: { currency: CURRENCY },
  plan_selected: { plan: PLAN, currency: CURRENCY },
  checkout_started: { plan: PLAN, currency: CURRENCY },
  checkout_details_saved: { plan: PLAN, currency: CURRENCY },
  payment_attempted: { plan: PLAN, currency: CURRENCY, gateway: GATEWAY, mode: MODE },
  payment_succeeded: { plan: PLAN, currency: CURRENCY, gateway: GATEWAY, mode: MODE },
  payment_failed: { plan: PLAN, currency: CURRENCY, gateway: GATEWAY, reason: REASON, mode: MODE },
  signup_completed: {},
  email_verified: {},
  login_completed: {},
  scan_started: { plan: PLAN },
  scan_completed: { plan: PLAN },
  scan_failed: { plan: PLAN, reason: REASON },
  scan_blocked: { reason: REASON },
  subscription_upgraded: { plan: PLAN, kind: KIND, mode: MODE },
  subscription_cancelled: { plan: PLAN },
};

/**
 * Keeps only the properties the event's schema allows, and only values
 * that match. Returns null when something unknown was sent — strict
 * rather than silently trimmed, so a bad client is noticed.
 */
export function validateProps(
  name: EventName,
  raw: unknown,
  { strict }: { strict: boolean },
): Record<string, string> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return strict ? null : {};
  const rules = PROPS[name];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rule = rules[key];
    if (!rule || typeof value !== "string" || !rule.test(value)) {
      if (strict) return null;
      continue;
    }
    out[key] = value;
  }
  return out;
}
