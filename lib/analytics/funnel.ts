import { many } from "@/lib/db";
import { ratio, scalar, type ReportScope, type Window } from "./common";

/**
 * Two funnels, because they answer different questions.
 *
 * The visitor journey follows tracked visitors through the site, in
 * order: a step counts only if it happened at or after the previous step.
 * Each visitor counts once per step however many times they repeat it.
 * Payment, account and scan steps are server events — written when the
 * server verified the payment, created the account or finished the scan
 * — never a browser's claim, and never a redirect back from a gateway.
 *
 * The account funnel needs no tracking: it takes the accounts registered
 * in the period and asks which of them went on to do each thing, from
 * the database records. It covers history from before tracking began.
 */

export type FunnelStep = {
  key: string;
  label: string;
  definition: string;
  count: number;
  /** count ÷ previous step's count. */
  fromPrevious: number | null;
  /** count ÷ first step's count. */
  fromStart: number | null;
  dropOff: number;
  dropOffRate: number | null;
};

export type Funnel = { steps: FunnelStep[]; overall: number | null; unit: string; denominator: string; extra?: Record<string, number> };

function finish(raw: { key: string; label: string; definition: string; count: number }[]): FunnelStep[] {
  return raw.map((step, i) => {
    const prev = i === 0 ? step.count : raw[i - 1].count;
    const first = raw[0].count;
    return {
      ...step,
      fromPrevious: i === 0 ? null : ratio(step.count, prev),
      fromStart: ratio(step.count, first),
      dropOff: i === 0 ? 0 : Math.max(0, prev - step.count),
      dropOffRate: i === 0 ? null : ratio(Math.max(0, prev - step.count), prev),
    };
  });
}

const JOURNEY: { key: string; label: string; definition: string; events: string[] }[] = [
  { key: "landing", label: "Visited the site", definition: "Visitors with at least one tracked page view.", events: ["page_view"] },
  { key: "pricing", label: "Viewed pricing", definition: "Opened the pricing page.", events: ["pricing_viewed"] },
  { key: "plan", label: "Selected a plan", definition: "Clicked a plan's buy or start button.", events: ["plan_selected"] },
  { key: "checkout", label: "Opened checkout", definition: "The checkout form was shown for a plan.", events: ["checkout_started"] },
  { key: "details", label: "Saved checkout details", definition: "Billing details passed server validation and were saved.", events: ["checkout_details_saved"] },
  { key: "attempt", label: "Started a payment", definition: "Pay was pressed and the server opened an order with the gateway.", events: ["payment_attempted"] },
  { key: "paid", label: "Payment verified", definition: "The server verified a live payment with the gateway (return or signed webhook). Test-mode payments are excluded.", events: ["payment_succeeded"] },
  { key: "account", label: "Account created or upgraded", definition: "A verified account was created, or a paid plan was activated.", events: ["email_verified", "subscription_upgraded"] },
  { key: "scan", label: "Started a scan", definition: "An eligibility scan was charged and started.", events: ["scan_started"] },
  { key: "scanned", label: "Completed a scan", definition: "The scan finished with a report.", events: ["scan_completed"] },
];

/** The tracked visitor journey. Denominator: visitors who reached step 1. */
export function journeyFunnel(scope: ReportScope): Funnel {
  const internal = scope.includeInternal ? "" : "AND internal = 0";
  const firstViews = many<{ v: string; t: number }>(
    `SELECT visitor_key AS v, MIN(occurred_at) AS t FROM analytics_events
      WHERE name = 'page_view' AND visitor_key IS NOT NULL AND occurred_at >= ? AND occurred_at < ? ${internal}
      GROUP BY visitor_key`,
    [scope.start, scope.end],
  );
  const later = many<{ v: string; name: string; t: number }>(
    `SELECT visitor_key AS v, name, occurred_at AS t FROM analytics_events
      WHERE visitor_key IS NOT NULL AND occurred_at >= ? AND occurred_at < ? ${internal}
        AND name IN ('pricing_viewed','plan_selected','checkout_started','checkout_details_saved','payment_attempted',
                     'payment_succeeded','payment_failed','email_verified','subscription_upgraded','scan_started','scan_completed')
        AND COALESCE(json_extract(props_json, '$.mode'), 'live') <> 'mock'
      ORDER BY occurred_at`,
    [scope.start, scope.end],
  );
  const byVisitor = new Map<string, { name: string; t: number }[]>();
  for (const row of later) {
    let list = byVisitor.get(row.v);
    if (!list) byVisitor.set(row.v, (list = []));
    list.push({ name: row.name, t: Number(row.t) });
  }

  const counts = new Array<number>(JOURNEY.length).fill(0);
  let failedAfterAttempt = 0;
  for (const { v, t } of firstViews) {
    counts[0] += 1;
    const events = byVisitor.get(v) ?? [];
    let at = Number(t);
    for (let step = 1; step < JOURNEY.length; step++) {
      const hit = events.find((e) => e.t >= at && JOURNEY[step].events.includes(e.name));
      if (!hit) {
        // Reached "started a payment" but not "verified": did it fail?
        if (step === 6 && events.some((e) => e.t >= at && e.name === "payment_failed")) failedAfterAttempt += 1;
        break;
      }
      at = hit.t;
      counts[step] += 1;
    }
  }

  const steps = finish(JOURNEY.map((s, i) => ({ key: s.key, label: s.label, definition: s.definition, count: counts[i] })));
  return {
    steps,
    overall: ratio(counts[counts.length - 1], counts[0]),
    unit: "visitors",
    denominator: "Visitors who reached the previous step (first step: all tracked visitors in the period).",
    extra: { paymentFailed: failedAfterAttempt },
  };
}

/**
 * Accounts registered in the window and what they have done since, from
 * records. A closed funnel: each step also requires the ones before it.
 * Payments are verified live payments only (test-mode orders excluded).
 */
export function accountFunnel(window: Window): Funnel {
  const p = [window.start, window.end];
  const base = "FROM users u WHERE u.role <> 'admin' AND u.created_at >= ? AND u.created_at < ?";
  const checkout = "EXISTS (SELECT 1 FROM checkout_sessions c WHERE c.user_id = u.id)";
  const attempt = "EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.mode = 'live')";
  const paid = "EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.mode = 'live')";
  const scanned = "EXISTS (SELECT 1 FROM reports r WHERE r.user_id = u.id)";
  const completed = "EXISTS (SELECT 1 FROM reports r WHERE r.user_id = u.id AND r.state = 'complete')";

  const registered = scalar(`SELECT COUNT(*) AS n ${base}`, p);
  const s1 = scalar(`SELECT COUNT(*) AS n ${base} AND ${checkout}`, p);
  const s2 = scalar(`SELECT COUNT(*) AS n ${base} AND ${checkout} AND ${attempt}`, p);
  const s3 = scalar(`SELECT COUNT(*) AS n ${base} AND ${checkout} AND ${attempt} AND ${paid}`, p);
  const s4 = scalar(`SELECT COUNT(*) AS n ${base} AND ${checkout} AND ${attempt} AND ${paid} AND ${scanned}`, p);
  const s5 = scalar(`SELECT COUNT(*) AS n ${base} AND ${checkout} AND ${attempt} AND ${paid} AND ${completed}`, p);

  const steps = finish([
    { key: "registered", label: "Registered (verified email)", definition: "Accounts created in the period. New accounts exist only after the emailed code is confirmed.", count: registered },
    { key: "details", label: "Saved checkout details", definition: "Has at least one saved checkout (recorded since checkout tracking was added).", count: s1 },
    { key: "attempt", label: "Started a live payment", definition: "Has at least one live payment order.", count: s2 },
    { key: "paid", label: "Paid", definition: "Has at least one verified live payment.", count: s3 },
    { key: "scan", label: "Ran a scan", definition: "Has at least one scan on record.", count: s4 },
    { key: "scanned", label: "Completed a scan", definition: "Has at least one completed scan report.", count: s5 },
  ]);
  return {
    steps,
    overall: ratio(s5, registered),
    unit: "accounts",
    denominator: "Accounts at the previous step (first step: accounts registered in the period). Outcomes are counted up to now.",
  };
}
