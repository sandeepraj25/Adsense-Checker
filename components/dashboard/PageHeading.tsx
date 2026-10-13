import { cn } from "@/lib/cn";

export function PageHeading({
  eyebrow,
  title,
  lede,
  action,
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lede?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <p className="t-eyebrow text-azure-600">{eyebrow}</p> : null}
        <h1 className="t-display mt-1 text-[1.75rem] leading-tight tracking-tight text-cloud-50 sm:text-[2rem]">
          {title}
        </h1>
        {lede ? (
          <p className="mt-2 max-w-xl text-[0.9375rem] leading-relaxed text-cloud-400">
            {lede}
          </p>
        ) : null}
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A single number with its label. Deliberately flat — a dashboard of
 * heavy cards competes with the report, which is the thing that should
 * hold attention.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "warn" | "fail" | "pass";
  className?: string;
}) {
  const valueTone = {
    default: "text-cloud-50",
    pass: "text-mint-400",
    warn: "text-amber-400",
    fail: "text-rose-400",
  }[tone];

  return (
    <div className={cn("glass rounded-xl px-4 py-4", className)}>
      <p className="text-[0.8125rem] font-medium text-cloud-400">{label}</p>
      <p className={cn("t-data mt-2 text-[1.5rem] font-semibold leading-none tracking-tight", valueTone)}>
        {value}
      </p>
      {hint ? (
        <p className="mt-2 text-[0.8125rem] leading-snug text-cloud-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Labelled row for the definition-list style blocks on billing/settings. */
export function DataRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-ink-850 py-3 last:border-0">
      <dt className="text-[0.875rem] text-cloud-400">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-[0.9375rem] font-medium text-cloud-50",
          // Ids and other machine values: readable, smaller, never overflowing.
          mono && "t-data break-all text-[0.8125rem] font-normal text-cloud-300",
        )}
      >
        {children}
      </dd>
    </div>
  );
}
