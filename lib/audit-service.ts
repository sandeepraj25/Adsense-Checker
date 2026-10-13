import { ALLOW_DEMO_FALLBACK } from "@/lib/env";
import type { ApiErrorCode } from "@/lib/http";
import {
  completeReport,
  countWebsites,
  createRunningReport,
  failReport,
  failStaleReports,
  findReport,
  pruneFailedReports,
  setReportAnalysisMode,
  touchWebsite,
  upsertWebsite,
  websiteExists,
  type NewIssue,
} from "@/lib/db/audits";
import {
  consumeScan,
  getActiveSubscription,
  refundScan,
  settleBilling,
} from "@/lib/db/billing";
import type { Report, User } from "@/lib/db/types";
import { accountBlock, effectiveFeatures, entitlementBlock } from "@/lib/entitlement";
import { demoAnalysis } from "@/lib/analysis/demo";
import { runAnalysis } from "@/lib/analysis/engine";
import { preflight } from "@/lib/analysis/fetcher";
import {
  describeTargetError,
  parseTarget,
  type TargetError,
} from "@/lib/analysis/target";
import { AnalysisFailure, CATEGORY_META, ENGINE_VERSION } from "@/lib/analysis/types";
import type { AnalysisOutcome } from "@/lib/analysis/types";
import type { FeatureKey } from "@/lib/plans";
import { trackServerEvent } from "@/lib/analytics/store";
import { newUuid } from "@/lib/ids";

/**
 * One gate, one quota deduction, one report.
 *
 * Both the API route and the dashboard action call this, so the
 * entitlement rules cannot drift between them. The order of the checks
 * matters: the user should be told the most specific true thing —
 * "your account is suspended" before "your plan expired" before "you are
 * out of scans this month".
 *
 * Two things happen before a scan is charged for. The target is parsed and
 * DNS-resolved, so an unreachable or internal address costs nothing; and
 * earlier failures on the same site are pruned, so a person who mistyped a
 * domain four times does not end up with four identical rows in their
 * history burying the reports that worked.
 */

export type StartAuditResult =
  | { ok: true; report: Report; demo: boolean }
  | { ok: false; code: ApiErrorCode; message: string };

function toIssues(outcome: AnalysisOutcome): NewIssue[] {
  return outcome.findings.map((finding) => ({
    checkId: finding.id,
    categoryId: finding.category,
    label: finding.label,
    status: finding.status,
    priority: finding.priority,
    detail: finding.detail,
    recommendation: finding.fix || null,
    evidence: finding.evidence ?? null,
    feature: finding.feature ?? null,
  }));
}

/**
 * "You typed something wrong" versus "we will not go there".
 *
 * Worth separating, because the second is a decision we made and the
 * person deserves to know it was deliberate rather than think the tool is
 * broken.
 */
const REFUSED: ReadonlySet<TargetError> = new Set<TargetError>([
  "scheme",
  "credentials",
  "port",
  "ip_literal",
]);


export async function startAudit(
  user: User,
  rawUrl: string,
): Promise<StartAuditResult> {
  // ── 1. The account ────────────────────────────────────────────────
  const suspended = accountBlock(user);
  if (suspended) {
    return { ok: false, code: suspended.code, message: suspended.message };
  }

  // ── 2. The target, before anything is charged for ─────────────────
  //
  // parseTarget normalises what was typed — bare domain, www, http://,
  // https:// all arrive here and all end up as one canonical target — and
  // rejects the addresses we will not dial. Errors from this stage are
  // free: no report row, no quota spent.
  const parsed = parseTarget(rawUrl);
  if (!parsed.ok) {
    return {
      ok: false,
      code: REFUSED.has(parsed.reason) ? "URL_NOT_ALLOWED" : "INVALID_URL",
      message: describeTargetError(parsed.reason),
    };
  }
  const domain = parsed.target.domain;

  // ── 3. Entitlement ────────────────────────────────────────────────
  failStaleReports();
  settleBilling();

  const subscription = getActiveSubscription(user.id);
  const blocked = entitlementBlock(subscription);
  if (blocked) {
    trackServerEvent("scan_blocked", { key: `blocked:${newUuid()}`, userId: user.id, props: { reason: blocked.code } });
    return { ok: false, code: blocked.code, message: blocked.message };
  }
  // entitlementBlock returns non-null for a missing subscription, so this
  // is narrowing for the type checker rather than a real branch.
  if (!subscription) {
    return {
      ok: false,
      code: "NO_ACTIVE_PLAN",
      message: "You do not have an active plan. Choose one to start scanning.",
    };
  }

  // The site limit only bites when this is a domain we have not seen for
  // this account — re-scanning an existing site is always allowed.
  if (
    subscription.siteLimit !== null &&
    !websiteExists(user.id, domain) &&
    countWebsites(user.id) >= subscription.siteLimit
  ) {
    trackServerEvent("scan_blocked", { key: `blocked:${newUuid()}`, userId: user.id, props: { reason: "SITE_LIMIT_REACHED" } });
    return {
      ok: false,
      code: "SITE_LIMIT_REACHED",
      message: `The ${subscription.planName} plan covers ${subscription.siteLimit} website${subscription.siteLimit === 1 ? "" : "s"}. Upgrade, or remove a site, to scan another domain.`,
    };
  }

  // ── 4. Reachability, still before charging ────────────────────────
  //
  // A DNS failure or a private address is not a scan. Resolving here means
  // "example.invalid" and "192.168.0.1" both cost the user nothing, which
  // is the difference between a limit that feels fair and one that feels
  // like a tax on typos.
  const reachable = await preflight(parsed.target);
  if (!reachable.ok) {
    // A deliberate refusal is always reported as a refusal. The demo path
    // exists for machines with no outbound network at all, where DNS fails
    // for everything — it must never turn "we will not scan your router's
    // admin page" into a cheerful sample report.
    if (reachable.kind === "blocked" || !ALLOW_DEMO_FALLBACK) {
      return {
        ok: false,
        code: reachable.kind === "blocked" ? "URL_NOT_ALLOWED" : "SITE_UNREACHABLE",
        message: reachable.message,
      };
    }
  }

  const features: FeatureKey[] = effectiveFeatures(subscription);
  const website = upsertWebsite(user.id, domain);

  // Clear earlier failures on this site before adding a new row, so the
  // history does not accumulate duplicates of the same failed attempt.
  pruneFailedReports(user.id, website.id);

  // Claim the quota atomically before doing any work, so two tabs cannot
  // both spend the last scan of the month.
  if (!consumeScan(subscription.id)) {
    trackServerEvent("scan_blocked", { key: `blocked:${newUuid()}`, userId: user.id, props: { reason: "LIMIT_REACHED" } });
    return {
      ok: false,
      code: "LIMIT_REACHED",
      message:
        "Monthly scan limit reached. Upgrade your plan or wait until your next billing cycle.",
    };
  }

  const report = createRunningReport({
    userId: user.id,
    websiteId: website.id,
    subscriptionId: subscription.id,
    url: parsed.target.url.toString(),
    domain,
    planId: subscription.planId,
    planName: subscription.planName,
    engineVersion: ENGINE_VERSION,
    analysisMode: "live",
    features,
  });
  trackServerEvent("scan_started", { key: `scan:${report.id}`, userId: user.id, props: { plan: subscription.planId } });

  let outcome: AnalysisOutcome;
  let demo = false;

  try {
    outcome = await runAnalysis(domain, features);
  } catch (error) {
    const unreachable = error instanceof AnalysisFailure && error.unreachable;

    if (unreachable && ALLOW_DEMO_FALLBACK) {
      outcome = demoAnalysis(domain, features);
      demo = true;
      setReportAnalysisMode(report.id, "demo");
    } else {
      // Never surface a raw exception: an internal message could name a
      // host, a path or a library, none of which is the user's business.
      const message =
        error instanceof AnalysisFailure
          ? error.message
          : "The scan failed unexpectedly. Your scan has been credited back — please try again.";
      failReport(report.id, message);
      trackServerEvent("scan_failed", {
        key: `scanfail:${report.id}`,
        userId: user.id,
        props: { plan: subscription.planId, reason: unreachable ? "SITE_UNREACHABLE" : "ANALYSIS_FAILED" },
      });
      // Not the user's fault, so give the scan back.
      refundScan(subscription.id);
      return {
        ok: false,
        code: unreachable ? "SITE_UNREACHABLE" : "ANALYSIS_FAILED",
        message,
      };
    }
  }

  completeReport({
    reportId: report.id,
    score: outcome.score,
    verdict: outcome.verdict,
    categories: outcome.categories.map((category) => ({
      id: category.id,
      name: category.name,
      score: category.score,
      weight: category.weight,
      passed: category.passed,
      warnings: category.warnings,
      critical: category.critical,
    })),
    passedCount: outcome.passedCount,
    warningCount: outcome.warningCount,
    criticalCount: outcome.criticalCount,
    pagesFetched: outcome.pagesFetched,
    issues: toIssues(outcome),
    features: outcome.features,
    locked: outcome.locked,
    pages: outcome.pages,
    metrics: outcome.metrics,
    checksRun: outcome.checksRun,
  });

  touchWebsite(website.id);
  trackServerEvent("scan_completed", { key: `scanok:${report.id}`, userId: user.id, props: { plan: subscription.planId } });

  // Re-read rather than merging in memory: the stored row is what every
  // other screen will show, so the caller should see exactly that.
  const stored = findReport(report.id);
  return { ok: true, report: stored ?? report, demo };
}

export { CATEGORY_META };
