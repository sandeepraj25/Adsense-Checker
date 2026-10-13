"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Globe, Loader2 } from "lucide-react";
import { useScan } from "@/components/ScanContext";
import { normalizeDomain } from "@/lib/domain";
import { cn } from "@/lib/cn";

export function UrlForm({
  size = "lg",
  className,
  cta = "Run free scan",
}: {
  size?: "md" | "lg";
  className?: string;
  cta?: string;
}) {
  const { runScan } = useScan();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tall = size === "lg";

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const domain = normalizeDomain(value);

    if (!domain) {
      setError("Enter your valid domain (e.g., skillforever.com).");
      return;
    }

    setError(null);
    setBusy(true);

    // Keeps any on-page preview in sync, then hands off to /start, which
    // decides where this visitor goes: signup if anonymous, straight to
    // the checker if they already have a session and an active plan.
    // `busy` is intentionally left true — the page is being replaced.
    runScan(domain);
    router.push(`/start?url=${encodeURIComponent(domain)}`);
  }

  return (
    <div className={cn("w-full", className)}>
      <form
        onSubmit={handleSubmit}
        noValidate
        className={cn(
          "group flex w-full flex-col gap-2 rounded-xl border border-zinc-300 bg-white p-1.5 sm:flex-row sm:items-center",
          "shadow-[0_1px_2px_rgba(24,24,27,0.05)] transition-colors",
          "focus-within:border-azure-500 focus-within:ring-3 focus-within:ring-azure-500/15",
        )}
      >
        <label htmlFor={`url-${size}`} className="sr-only">
          Your website address
        </label>

        <div className="flex flex-1 items-center gap-3 px-4">
          <Globe
            className="size-5 shrink-0 text-cloud-400"
            aria-hidden
          />

          <input
            id={`url-${size}`}
            name="url"
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Enter Your Valid Domain Name"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `url-${size}-error` : undefined}
            className={cn(
              "w-full bg-transparent font-sans font-medium text-cloud-50 outline-none",
              "placeholder:text-cloud-400",
              tall ? "h-14 text-[1.05rem]" : "h-11 text-[0.95rem]",
            )}
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-azure-500 px-6 font-semibold text-white",
            "transition-colors hover:bg-azure-600",
            "disabled:opacity-70",
            tall ? "h-14 text-[1rem]" : "h-11 text-[0.9rem]",
          )}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Scanning
            </>
          ) : (
            <>
              {cta}
              <ArrowRight
                className="size-4 transition-transform duration-300 group-hover:translate-x-0.5"
                aria-hidden
              />
            </>
          )}
        </button>
      </form>

      <div className="mt-3 min-h-5 px-1">
        {error ? (
          <p
            id={`url-${size}-error`}
            role="alert"
            className="font-sans text-sm text-rose-400"
          >
            {error}
          </p>
        ) : (
          <p className="font-sans text-sm text-cloud-400">
            Enter your valid domain (e.g., skillforever.com).          </p>
        )}
      </div>
    </div>
  );
}
