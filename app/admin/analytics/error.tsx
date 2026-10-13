"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/Button";

/**
 * A report query failed. The rest of the admin panel (and the public
 * site) is unaffected; the admin can retry or pick another range.
 */
export default function AnalyticsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="glass mx-auto mt-6 max-w-lg rounded-xl px-6 py-8 text-center">
      <AlertTriangle className="mx-auto size-8 text-amber-400" aria-hidden />
      <h1 className="mt-3 text-[1.125rem] font-semibold text-cloud-50">This report couldn&apos;t be loaded</h1>
      <p className="mt-1 text-[0.9375rem] leading-relaxed text-cloud-400">
        The analytics query failed. Nothing else on the site is affected. Try again, or choose a shorter date range.
      </p>
      <Button className="mt-5" size="sm" onClick={() => reset()}>
        <RotateCcw className="size-4" aria-hidden />
        Try again
      </Button>
    </div>
  );
}
