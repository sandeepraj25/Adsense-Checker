
"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";

/**
 * Monthly / Yearly switch above the plan cards.
 * Existing billing state and server-rendered prices remain unchanged.
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
  bestDiscount: number | null;
  className?: string;
}) {
  const [cycle, setCycle] = useState<"monthly" | "yearly">(initial);

  const option = (
    value: "monthly" | "yearly",
    label: React.ReactNode,
  ) => (
    <button
      type="button"
      role="radio"
      aria-checked={cycle === value}
      onClick={() => setCycle(value)}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-semibold transition-all duration-200 sm:px-7",
        cycle === value
          ? "bg-white text-blue-700 shadow-sm"
          : "text-white hover:bg-white/10",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className={className}>
      <div className="mb-8 flex justify-center">
        <div
          role="radiogroup"
          aria-label="Billing period"
          className="inline-flex items-center rounded-full border border-blue-600 bg-blue-600 p-1.5 shadow-md shadow-blue-600/15"
        >
          {option("monthly", "Monthly")}

          {option(
            "yearly",
            <>
              <span>Yearly</span>

              {bestDiscount ? (
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-bold leading-4",
                    cycle === "yearly"
                      ? "bg-blue-50 text-blue-700"
                      : "bg-white/15 text-white",
                  )}
                >
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
