"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Globe, Radar } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import {
  ProgressStages,
  useStageProgress,
} from "@/components/ui/ProgressStages";
import { normalizeDomain } from "@/lib/domain";
import type { ApiErrorCode } from "@/lib/http";

type Failure = { ok: false; code: ApiErrorCode; message: string };
type Success = { ok: true; reportId: string; demo: boolean; queued?: boolean };

/** How often, and for how long, the page checks on a background scan. */
const POLL_MS = 2_000;
const POLL_FOR_MS = 6 * 60_000;

type Settled = { ok: true; demo: boolean } | Failure | { ok: "pending" };

/** Waits for a background scan to finish, by reading its report. */
async function waitForReport(reportId: string): Promise<Settled> {
  const until = Date.now() + POLL_FOR_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      const res = await fetch(`/api/reports/${reportId}`, { cache: "no-store" });
      if (!res.ok) continue;
      const data = (await res.json()) as { ok: boolean; report?: { state: string; analysisMode: string; errorCode: ApiErrorCode | null; errorMessage: string | null } };
      const report = data.report;
      if (!report || report.state === "running") continue;
      if (report.state === "complete") return { ok: true, demo: report.analysisMode === "demo" };
      return { ok: false, code: report.errorCode ?? "ANALYSIS_FAILED", message: report.errorMessage ?? "The scan did not finish." };
    } catch {
      // A dropped poll is retried; the scan carries on on the server.
    }
  }
  return { ok: "pending" };
}

const BILLING_CODES: ReadonlySet<ApiErrorCode> = new Set([
  "NO_ACTIVE_PLAN",
  "PLAN_EXPIRED",
  "LIMIT_REACHED",
  "SITE_LIMIT_REACHED",
  "FEATURE_LOCKED",
]);

const FIELD_CODES: ReadonlySet<ApiErrorCode> = new Set([
  "INVALID_URL",
  "URL_NOT_ALLOWED",
  "DNS_FAILURE",
  "SITE_UNREACHABLE",
]);

const RETRY_CODES: ReadonlySet<ApiErrorCode> = new Set([
  "ANALYSIS_FAILED",
  "SERVER_ERROR",
  "RATE_LIMITED",
  "SITE_UNREACHABLE",
]);

export function CheckerPanel({
  initialUrl = "",
  autoRun = false,
  usage,
  checks,
  blocked,
}: {
  initialUrl?: string;
  autoRun?: boolean;
  usage: {
    used: number;
    limit: number;
    remaining: number;
    resetsOn: string;
    /** Content pages one scan reads on this plan. */
    pagesPerScan?: number;
  } | null;
  checks: number;
  blocked?: { code: ApiErrorCode; message: string } | null;
}) {
  const router = useRouter();
  const { success, error: errorToast, toast } = useToast();
  const stage = useStageProgress();

  const [url, setUrl] = useState(initialUrl);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | null>(
    blocked ? { ok: false, ...blocked } : null,
  );
  const [running, setRunning] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const started = useRef(false);

  const remaining = usage?.remaining ?? 0;

  const run = useCallback(
    async (raw: string) => {
      const domain = normalizeDomain(raw);

      if (!domain) {
        setFieldError("Enter a valid domain name");
        return;
      }

      setFieldError(undefined);
      setFailure(null);
      setTarget(domain);
      setRunning(true);
      stage.start();

      try {
        const res = await fetch("/api/analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: domain }),
        });

        const first = (await res.json()) as Success | Failure;
        // The scan runs in the background; wait for its report.
        let data: Success | Failure = first;
        if (first.ok && first.queued) {
          const settled = await waitForReport(first.reportId);
          if (settled.ok === "pending") {
            // Still going after several minutes: hand over to the report
            // page, which keeps checking on it.
            router.push(`/dashboard/reports/${first.reportId}`);
            return;
          }
          data = settled.ok ? { ...first, demo: settled.demo } : settled;
        }

        if (!data.ok) {
          stage.fail();
          setRunning(false);
          setFailure(data);

          if (FIELD_CODES.has(data.code)) {
            setFieldError(data.message);
          } else {
            errorToast("Scan stopped", data.message);
          }

          return;
        }

        stage.finish();

        if (data.demo) {
          toast({
            tone: "info",
            title: "Demo report generated",
            detail:
              "The site could not be reached from this server, so the report is seeded demo data. It is labelled as such.",
            duration: 9000,
          });
        } else {
          success(
            "Scan complete",
            `${domain} scored on ${checks} check${checks === 1 ? "" : "s"}.`,
          );
        }

        window.setTimeout(() => {
          router.push(`/dashboard/reports/${data.reportId}`);
          router.refresh();
        }, 420);
      } catch {
        stage.fail();
        setRunning(false);

        setFailure({
          ok: false,
          code: "SERVER_ERROR",
          message:
            "We lost the connection while starting the scan. If it started, it will appear under Reports; otherwise nothing was counted — try again.",
        });
      }
    },
    [checks, errorToast, router, stage, success, toast],
  );

  useEffect(() => {
    if (started.current) return;
    if (!autoRun || !initialUrl || blocked) return;

    started.current = true;
    void run(initialUrl);
  }, [autoRun, blocked, initialUrl, run]);

  if (running || stage.phase === "done") {
    return (
      <ProgressStages
        phase={stage.phase}
        index={stage.index}
        target={target ?? undefined}
      />
    );
  }

  const needsPlan = failure && BILLING_CODES.has(failure.code);

  return (
    <div className="flex flex-col gap-4">
      {/* MAIN SCAN CARD */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(url);
        }}
        noValidate
        className="glass overflow-hidden rounded-xl p-5 sm:p-6"
      >
        <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          {/* LEFT SIDE */}
          <div>
            <div className="flex items-center gap-2.5">
              <Globe className="size-4 text-azure-600" aria-hidden />
              <h2 className="t-h3 text-cloud-50">Quick website check</h2>
            </div>

            <p className="mt-2 text-[0.9375rem] text-cloud-400">
              Your plan runs{" "}
              <span className="t-data text-cloud-200">{checks}</span> check
              {checks === 1 ? "" : "s"} per scan.
              {usage ? (
                <>
                  {" "}
                  <span className="t-data text-cloud-200">
                    {usage.used} / {usage.limit}
                  </span>{" "}
                  scans used this month
                  {usage.pagesPerScan ? (
                    <>
                      {" "}
                      · up to <span className="t-data text-cloud-200">{usage.pagesPerScan}</span>{" "}
                      {usage.pagesPerScan === 1 ? "page" : "pages"} per scan
                    </>
                  ) : null}
                  .
                </>
              ) : null}
            </p>

            {usage && usage.remaining < 1 ? (
              <p className="mt-3 text-[0.875rem] leading-snug text-amber-400">
                Monthly scan limit reached. Upgrade your plan or wait until
                your next billing cycle — your allowance resets on{" "}
                {usage.resetsOn}.
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-start">
              <Field
                label="Website address"
                name="url"
                mono
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder="Enter Your Valid Domain Name"
                value={url}
                error={fieldError}
                onChange={(event) => {
                  setUrl(event.target.value);

                  if (fieldError) {
                    setFieldError(undefined);
                  }
                }}
                className="flex-1"
              />

              <Button
                type="submit"
                size="md"
                disabled={remaining < 1}
                className="sm:mt-[1.6rem]"
              >
                <Radar className="size-4" aria-hidden />
                Check website
              </Button>
            </div>
          </div>

          {/* RIGHT SIDE IMAGE */}
          <div className="relative hidden lg:flex items-center justify-center">
            <Image
              src="/scan-website.png"
              alt="Website scanning illustration"
              width={500}
              height={500}
              className="h-auto w-full max-w-[380px] object-contain"
              priority
            />
          </div>
        </div>
      </form>

      {/* ERROR */}
      {failure ? (
        <div className="glass flex flex-col gap-3 rounded-xl border-amber-400/20 bg-amber-400/[0.05] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-400"
              aria-hidden
            />

            <p className="text-[0.9375rem] leading-snug text-cloud-200">
              {failure.message}
            </p>
          </div>

          {needsPlan ? (
            <ButtonLink href="/pricing" size="sm" className="shrink-0">
              See plans
            </ButtonLink>
          ) : RETRY_CODES.has(failure.code) ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run(url)}
              className="shrink-0"
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {stage.phase === "failed" && !failure ? (
        <p className="flex items-center gap-2 text-[0.875rem] text-cloud-600">
          <Spinner className="size-3" />
          Cleaning up…
        </p>
      ) : null}
    </div>
  );
}