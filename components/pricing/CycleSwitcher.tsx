"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";

/**
 * Monthly / Yearly switch above the plan cards. Both sets of cards are
 * rendered on the server; this only shows one of them, so prices are never
 * computed in the browser and switching needs no request.
 */
export function CycleSwitcher({
  monthly,
  yearly,
  initial = "monthly",
  bestDiscount,
  className,
}: {
  monthly: React.ReactNode;
  yearly: React.ReactNode;
  initial?: "monthly" | "yearly";
  /** The largest yearly saving on offer, for the switch's hint. */
  bestDiscount: number | null;
  className?: string;
}) {
  const [cycle, setCycle] = useState<"monthly" | "yearly">(initial);
  const option = (value: "monthly" | "yearly", label: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={cycle === value}
      onClick={() => setCycle(value)}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[0.875rem] font-medium transition-colors",
        cycle === value ? "bg-white text-cloud-50 shadow-[0_1px_2px_rgba(24,24,27,0.08)]" : "text-cloud-300 hover:text-cloud-50",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className={className}>
      <div className="mb-8 flex justify-center">
        <div role="radiogroup" aria-label="Billing period" className="inline-flex rounded-full border border-ink-700 bg-ink-900 p-1">
          {option("monthly", "Monthly")}
          {option(
            "yearly",
            <>
              Yearly
              {bestDiscount ? (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-emerald-700">
                  Save up to {bestDiscount}%
                </span>
              ) : null}
            </>,
          )}
        </div>
      </div>
      <div hidden={cycle !== "monthly"}>{monthly}</div>
      <div hidden={cycle !== "yearly"}>{yearly}</div>
    </div>
  );
}
