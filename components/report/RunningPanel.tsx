"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Shown when a report row is still in the `running` state — which only
 * happens if the tab that started it went away mid-run. It polls the
 * server a bounded number of times rather than forever, so a genuinely
 * stuck run settles into a manual reload instead of hammering the app.
 */
const INTERVAL_MS = 4000;
const MAX_POLLS = 90; // six minutes: the longest scans run about four

export function RunningPanel() {
  const router = useRouter();
  const [polls, setPolls] = useState(0);
  const watching = polls < MAX_POLLS;

  useEffect(() => {
    if (!watching) return;

    const timer = setTimeout(() => {
      setPolls((count) => count + 1);
      router.refresh();
    }, INTERVAL_MS);

    return () => clearTimeout(timer);
  }, [polls, watching, router]);

  return (
    <div className="glass flex flex-col items-start gap-4 rounded-xl p-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3">
        <Spinner className="mt-1 text-azure-600" label="Analysis running" />
        <div>
          <p className="text-[0.9375rem] text-cloud-50">
            {watching
              ? "This scan is still running."
              : "This scan has been running for a while."}
          </p>
          <p className="mt-1 max-w-lg text-[0.875rem] leading-relaxed text-cloud-600">
            {watching
              ? "The page is checking for the result every few seconds. Scans of plans with many pages can take a few minutes. A run that stops responding is marked failed automatically and the scan is returned to your monthly allowance."
              : "It has probably failed. Reload once more — stalled runs are marked failed and the scan is returned to your monthly allowance."}
          </p>
        </div>
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="shrink-0"
        onClick={() => {
          setPolls(0);
          router.refresh();
        }}
      >
        <RotateCw className="size-3.5" aria-hidden />
        Reload
      </Button>
    </div>
  );
}
