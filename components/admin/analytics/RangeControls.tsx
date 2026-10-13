"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange } from "lucide-react";

import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

const PRESETS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom range" },
];

const INTERVALS = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

/**
 * Date range, trend interval and the internal-traffic filter. Everything
 * lives in the URL, so a view can be bookmarked or shared with another
 * admin and the browser's back button works.
 */
export function RangeControls({
  range,
  from,
  to,
  interval,
  internal,
  showInternalToggle,
  today,
}: {
  range: string;
  from: string;
  to: string;
  interval: string;
  internal: boolean;
  showInternalToggle: boolean;
  /** Today in the reporting timezone, the latest date the picker allows. */
  today: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, start] = useTransition();
  const [preset, setPreset] = useState(range);
  const [custom, setCustom] = useState({ from, to });
  const [error, setError] = useState<string | null>(null);

  function go(changes: Record<string, string | null>) {
    const params = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    // A new range resets table pages.
    params.delete("pp");
    params.delete("up");
    start(() => router.push(`${pathname}?${params.toString()}`, { scroll: false }));
  }

  function applyCustom() {
    if (!custom.from || !custom.to) return setError("Choose both dates.");
    if (custom.from > custom.to) return setError("The start date must be on or before the end date.");
    setError(null);
    go({ range: "custom", from: custom.from, to: custom.to });
  }

  const fieldClass =
    "h-9 rounded-lg border border-ink-700 bg-white px-2.5 text-[0.875rem] text-cloud-50 focus-visible:border-azure-500 focus-visible:outline-2 focus-visible:outline-azure-500/30";

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="an-range" className="text-[0.75rem] font-medium text-cloud-400">
          Date range
        </label>
        <div className="flex items-center gap-2">
          <CalendarRange className="size-4 text-cloud-400" aria-hidden />
          <select
            id="an-range"
            value={preset}
            onChange={(event) => {
              const value = event.target.value;
              setPreset(value);
              if (value !== "custom") go({ range: value, from: null, to: null });
            }}
            className={cn(fieldClass, "min-w-40")}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {preset === "custom" ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="an-from" className="text-[0.75rem] font-medium text-cloud-400">
              From
            </label>
            <input id="an-from" type="date" max={today} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={fieldClass} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="an-to" className="text-[0.75rem] font-medium text-cloud-400">
              To
            </label>
            <input id="an-to" type="date" max={today} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={fieldClass} />
          </div>
          <button
            type="button"
            onClick={applyCustom}
            className="inline-flex h-9 items-center rounded-lg bg-azure-500 px-3.5 text-[0.875rem] font-medium text-white hover:bg-azure-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
          >
            Apply
          </button>
          {error ? (
            <p role="alert" className="w-full text-[0.8125rem] text-rose-400">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[0.75rem] font-medium text-cloud-400">Trend by</legend>
        <div className="inline-flex rounded-lg border border-ink-700 bg-white p-0.5">
          {INTERVALS.map((option) => (
            <label
              key={option.value}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-1 text-[0.8125rem] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-azure-500",
                interval === option.value ? "bg-azure-500/[0.09] text-azure-600" : "text-cloud-300 hover:text-cloud-50",
              )}
            >
              <input
                type="radio"
                name="an-interval"
                value={option.value}
                checked={interval === option.value}
                onChange={() => go({ interval: option.value })}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {showInternalToggle ? (
        <label className="inline-flex h-9 items-center gap-2 text-[0.875rem] text-cloud-200">
          <input
            type="checkbox"
            checked={internal}
            onChange={(event) => go({ internal: event.target.checked ? "1" : null })}
            className="size-4 accent-azure-500"
          />
          Include internal traffic
        </label>
      ) : null}

      {pending ? (
        <span className="inline-flex h-9 items-center gap-2 text-[0.8125rem] text-cloud-400" role="status">
          <Spinner /> Updating…
        </span>
      ) : null}
    </div>
  );
}
