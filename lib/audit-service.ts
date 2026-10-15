import { ALLOW_DEMO_FALLBACK } from "@/lib/env";
import type { ApiErrorCode } from "@/lib/http";
import {
  completeReport,
  countRunningReports,
  countWebsites,
  createRunningReport,
  failAndRefund,
  failStaleReports,
  findReport,
  pruneFailedReports,
  setReportAnalysisMode,
  touchWebsite,
  upsertWebsite,
  websiteExists,
  type NewIssue,
} from "@/lib/db/audits";
import { tx } from "@/lib/db";
import { MAX_RUNNING_SCANS_PER_ACCOUNT, limitReachedMessage, pagesPerScanFor } from "@/lib/limits";
import { runScanJob } from "@/lib/scans/jobs";
import {
  consumeScan,
  getActiveSubscription,
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
import { collectScanFeatures } from "@/lib/ml/collect";
import { buildFeatureVector, type FeatureVector } from "@/lib/ml/features";
import { estimateApproval, type Estimate } from "@/lib/ml/predict";
import { ruleBasedEstimate } from "@/lib/ml/rules";
import { INSIGHTS, runInsights } from "@/lib/analysis/insights";

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
  /** `queued`: the scan is running in the background; poll the report. */
  | { ok: true; report: Report; demo: boolean; queued?: boolean }
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
    analyzer: finding.analyzer ?? null,
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


/** The approval estimate, falling back to the published rule if the model layer itself fails. */
function safeEstimate(vector: FeatureVector): Estimate {
  try {
    return estimateApproval(vector);
  } catch (error) {
    console.error(`[ml] estimate failed: ${error instanceof Error ? error.message : error}`);
    return ruleBasedEstimate(vector);
  }
}

export async function startAudit(
  user: User,
  rawUrl: string,
  /** wait: run the scan and return its finished report (weekly rescans). */
  options: { wait?: boolean } = {},
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

  // ── 5. One step: no overlap, under the account's running limit, and
  //       one scan claimed from this month's allowance ─────────────────
  //
  // All three are decided inside one write transaction, so two requests
  // fired together cannot both pass: a second scan of a site already
  // running, a third concurrent scan, or a scan past the monthly limit is
  // refused and costs nothing.
  const pageLimit = pagesPerScanFor(subscription);
  const claim = tx((): { ok: true; report: Report } | { ok: false; code: ApiErrorCode; message: string } => {
    if (countRunningReports(user.id, domain) > 0) {
      return { ok: false, code: "SCAN_IN_PROGRESS", message: `A scan of ${domain} is already running. Its report will open when it finishes.` };
    }
    if (countRunningReports(user.id) >= MAX_RUNNING_SCANS_PER_ACCOUNT) {
      return {
        ok: false,
        code: "SCAN_IN_PROGRESS",
        message: `You already have ${MAX_RUNNING_SCANS_PER_ACCOUNT} scans running. Start another when one finishes — nothing has been counted.`,
      };
    }
    if (!consumeScan(subscription.id)) {
      return {
        ok: false,
        code: "LIMIT_REACHED",
        message: limitReachedMessage(subscription),
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
      pageLimit,
    });
    return { ok: true, report };
  });
  if (!claim.ok) {
    trackServerEvent("scan_blocked", { key: `blocked:${newUuid()}`, userId: user.id, props: { reason: claim.code } });
    return claim;
  }
  const report = claim.report;
  trackServerEvent("scan_started", { key: `scan:${report.id}`, userId: user.id, props: { plan: subscription.planId } });

  // ── 6. The scan itself, as a background job ───────────────────────
  const job = runScanJob(report.id, () =>
    runAuditJob({ user, report, subscription, domain, websiteId: website.id, features, pageLimit }),
  );
  if (options.wait) {
    const result = await job;
    if (!result) {
      return { ok: false, code: "ANALYSIS_FAILED", message: "The scan failed unexpectedly. Your scan has been credited back — please try again." };
    }
    if (!result.ok) return result;
    return { ok: true, report: findReport(report.id) ?? report, demo: result.demo };
  }
  void job;
  return { ok: true, report, demo: false, queued: true };
}

/**
 * The work of one scan: crawl and analyse, add the smart insights, store
 * the report and its training row — or fail it, with a reason and a
 * refund. Never throws.
 */
async function runAuditJob(input: {
  user: User;
  report: Report;
  subscription: NonNullable<ReturnType<typeof getActiveSubscription>>;
  domain: string;
  websiteId: string;
  features: FeatureKey[];
  pageLimit: number;
}): Promise<{ ok: true; demo: boolean } | { ok: false; code: ApiErrorCode; message: string }> {
  const { user, report, subscription, domain, features } = input;
  let outcome: AnalysisOutcome;
  let demo = false;

  try {
    outcome = await runAnalysis(domain, features, { pageLimit: input.pageLimit });
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
      if (!(error instanceof AnalysisFailure)) {
        console.error(`[analysis] scan ${report.id} failed: ${error instanceof Error ? error.message : error}`);
      }
      const code: ApiErrorCode = unreachable ? "SITE_UNREACHABLE" : "ANALYSIS_FAILED";
      // Not the user's fault, so the scan is given back (once).
      failAndRefund(report.id, subscription.id, message, code);
      trackServerEvent("scan_failed", {
        key: `scanfail:${report.id}`,
        userId: user.id,
        props: { plan: subscription.planId, reason: code },
      });
      return { ok: false, code, message };
    }
  }

  try {
    // ── Smart insights (features 48–53) over the scored scan ──────────
    // They explain the result (estimate, likely reasons, comparison, what
    // changed, timeline, schedule) and never change the score or counts.
    const vector = buildFeatureVector(outcome);
    const estimate = safeEstimate(vector);
    let insightLines: AnalysisOutcome["findings"] = [];
    try {
      insightLines = (
        await runInsights(INSIGHTS, {
          userId: user.id,
          domain,
          reportId: report.id,
          websiteId: input.websiteId,
          planId: subscription.planId,
          outcome,
          vector,
          estimate,
          features: new Set<string>(features),
          demo,
          now: Date.now(),
        })
      ).findings;
    } catch (error) {
      console.error(`[analysis] insights failed for ${report.id}: ${error instanceof Error ? error.message : error}`);
    }
    const reported: AnalysisOutcome = insightLines.length
      ? { ...outcome, findings: [...outcome.findings, ...insightLines], checksRun: outcome.checksRun + insightLines.length }
      : outcome;

    const stored = completeReport({
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
      issues: toIssues(reported),
      features: outcome.features,
      locked: outcome.locked,
      pages: outcome.pages,
      metrics: outcome.metrics,
      checksRun: reported.checksRun,
    });
    if (!stored) {
      // The scan stopped beating and was already failed and refunded by
      // the stale sweep; its late result is discarded.
      const latest = findReport(report.id);
      return {
        ok: false,
        code: (latest?.errorCode as ApiErrorCode | null) ?? "ANALYSIS_FAILED",
        message: latest?.errorMessage ?? "The analysis was interrupted before it finished. The scan was returned to your monthly allowance.",
      };
    }

    touchWebsite(input.websiteId);

    // Training data for the prediction model (lib/ml): the scan's numbers,
    // never its text. Demo reports are skipped; a failure here is logged
    // and never fails the scan.
    collectScanFeatures({
      reportId: report.id,
      userId: user.id,
      domain,
      planId: subscription.planId,
      demo,
      outcome,
      vector,
      estimate,
    });
    trackServerEvent("scan_completed", { key: `scanok:${report.id}`, userId: user.id, props: { plan: subscription.planId } });
    return { ok: true, demo };
  } catch (error) {
    console.error(`[analysis] storing scan ${report.id} failed: ${error instanceof Error ? error.message : error}`);
    try {
      failAndRefund(report.id, subscription.id, "The scan finished but its report couldn't be saved. Your scan has been credited back — please try again.", "ANALYSIS_FAILED");
    } catch (inner) {
      // The sweep fails and refunds it within 90 seconds.
      console.error(`[analysis] could not mark ${report.id} failed: ${inner instanceof Error ? inner.message : inner}`);
    }
    return { ok: false, code: "ANALYSIS_FAILED", message: "The scan failed unexpectedly. Your scan has been credited back — please try again." };
  }
}

export { CATEGORY_META };
