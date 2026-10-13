import Link from "next/link";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Download, Info, Minus } from "lucide-react";

import { cn } from "@/lib/cn";
import type { Ranked } from "@/lib/analytics/common";
import type { KpiFormat } from "@/lib/analytics/report";
import { change, fmtInt, fmtPct, fmtValue } from "./format";

/**
 * Small server-rendered pieces of the analytics dashboard. Charts that
 * react to the pointer live in Charts.tsx; everything here is static.
 */

/** A definition behind an (i) — shown on hover and on keyboard focus. */
export function Definition({ text, label }: { text: string; label: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`What “${label}” means`}
        className="grid size-5 place-items-center rounded-full text-cloud-400 transition-colors hover:text-cloud-50 focus-visible:text-cloud-50 focus-visible:outline-2 focus-visible:outline-azure-500"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute top-6 left-1/2 z-30 hidden w-[min(16rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-ink-700 bg-white px-3 py-2 text-[0.8125rem] leading-snug font-normal text-cloud-200 shadow-[0_8px_24px_rgba(24,24,27,0.12)] group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

export function ChangePill({
  current,
  previous,
  format,
  lowerIsBetter = false,
}: {
  current: number | null;
  previous: number | null;
  format: KpiFormat;
  lowerIsBetter?: boolean;
}) {
  const c = change(current, previous, format);
  if (c.direction === "none") return <span className="text-[0.75rem] text-cloud-400">No comparison</span>;
  const good = c.direction === "flat" ? null : (c.direction === "up") !== lowerIsBetter;
  const Icon = c.direction === "up" ? ArrowUpRight : c.direction === "down" ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[0.75rem] font-medium",
        good === null ? "bg-ink-850 text-cloud-300" : good ? "bg-mint-400/[0.08] text-mint-400" : "bg-rose-400/[0.07] text-rose-400",
      )}
    >
      <Icon className="size-3" aria-hidden />
      {c.text}
      <span className="sr-only"> compared with the previous period</span>
    </span>
  );
}

export function KpiCard({
  label,
  definition,
  value,
  previous,
  format,
  lowerIsBetter,
  unavailable,
  note,
  source,
  children,
}: {
  label: string;
  definition: string;
  value: number | null;
  previous: number | null;
  format: KpiFormat;
  lowerIsBetter?: boolean;
  unavailable?: string;
  note?: string;
  source: "tracked" | "records";
  children?: React.ReactNode;
}) {
  return (
    <div className="glass flex min-w-0 flex-col rounded-xl px-4 py-3.5">
      <div className="flex items-center gap-1">
        <p className="truncate text-[0.8125rem] font-medium text-cloud-300">{label}</p>
        <Definition text={`${definition} Source: ${source === "tracked" ? "first-party tracking" : "application records"}.`} label={label} />
      </div>
      {children ?? (
        unavailable ? (
          <p className="mt-2 text-[0.8125rem] leading-snug text-cloud-400">{unavailable}</p>
        ) : (
          <>
            <p className="t-data mt-1.5 text-[1.375rem] leading-none font-semibold tracking-tight text-cloud-50">{fmtValue(value, format)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <ChangePill current={value} previous={previous} format={format} lowerIsBetter={lowerIsBetter} />
              {previous !== null ? <span className="text-[0.75rem] text-cloud-400">was {fmtValue(previous, format)}</span> : null}
            </div>
          </>
        )
      )}
      {note ? <p className="mt-1.5 text-[0.75rem] leading-snug text-cloud-400">{note}</p> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("glass min-w-0 rounded-xl", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-[0.9375rem] font-semibold text-cloud-50">{title}</h2>
          {description ? <p className="mt-0.5 max-w-2xl text-[0.8125rem] leading-relaxed text-cloud-400">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/** Horizontal bars with the value; the bar is relative to the largest row. */
export function BarList({
  rows,
  valueLabel,
  secondaryLabel,
  secondaryFormat = "int",
  empty,
  mono = false,
}: {
  rows: Ranked[];
  valueLabel: string;
  secondaryLabel?: string;
  secondaryFormat?: "int" | "pct";
  empty: string;
  mono?: boolean;
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-[0.875rem] text-cloud-400">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  return (
    <div>
      <div className="mb-1.5 flex justify-between gap-3 text-[0.75rem] font-medium text-cloud-400">
        <span>{mono ? "Page" : "Name"}</span>
        <span className="flex gap-4">
          {secondaryLabel ? <span className="w-16 text-right">{secondaryLabel}</span> : null}
          <span className="w-14 text-right">{valueLabel}</span>
        </span>
      </div>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.label} className="relative flex items-center justify-between gap-3 overflow-hidden rounded-md px-2 py-1.5">
            <span aria-hidden className="absolute inset-y-0 left-0 rounded-md bg-azure-500/[0.08]" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
            <span className={cn("relative min-w-0 truncate text-[0.8125rem] text-cloud-100", mono && "t-data text-[0.78rem]")} title={row.label}>
              {row.label}
            </span>
            <span className="relative flex shrink-0 gap-4 text-[0.8125rem]">
              {secondaryLabel ? (
                <span className="t-data w-16 text-right text-cloud-400">
                  {row.secondary === null || row.secondary === undefined ? "—" : secondaryFormat === "pct" ? fmtPct(row.secondary, 0) : fmtInt(row.secondary)}
                </span>
              ) : null}
              <span className="t-data w-14 text-right font-medium text-cloud-50">
                {fmtInt(row.value)}
                <span className="sr-only"> ({fmtPct(total ? row.value / total : null, 0)})</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn"; title: string; children?: React.ReactNode }) {
  return (
    <div
      role={tone === "warn" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-xl border px-4 py-3 text-[0.875rem] leading-relaxed",
        tone === "warn" ? "border-amber-400/30 bg-amber-400/[0.06]" : "border-azure-500/20 bg-azure-500/[0.04]",
      )}
    >
      {tone === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0 text-azure-600" aria-hidden />}
      <div className="min-w-0">
        <p className="font-semibold text-cloud-50">{title}</p>
        {children ? <div className="mt-0.5 text-cloud-300">{children}</div> : null}
      </div>
    </div>
  );
}

export function ExportLink({ href, enabled, label = "CSV" }: { href: string; enabled: boolean; label?: string }) {
  if (!enabled) return null;
  return (
    <a
      href={href}
      download
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-white px-2.5 text-[0.8125rem] font-medium text-cloud-200 transition-colors hover:border-zinc-300 hover:text-cloud-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
    >
      <Download className="size-3.5" aria-hidden />
      {label}
    </a>
  );
}

export function Stat({ label, value, hint, definition }: { label: string; value: React.ReactNode; hint?: React.ReactNode; definition?: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[0.8125rem] text-cloud-400">
        {label}
        {definition ? <Definition text={definition} label={label} /> : null}
      </dt>
      <dd className="t-data mt-0.5 text-[1.125rem] font-semibold text-cloud-50">{value}</dd>
      {hint ? <dd className="text-[0.75rem] leading-snug text-cloud-400">{hint}</dd> : null}
    </div>
  );
}

export function Pager({ page, total, pageSize, href }: { page: number; total: number; pageSize: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const link = "inline-flex h-8 items-center rounded-md border border-ink-700 bg-white px-2.5 text-[0.8125rem] font-medium text-cloud-200 hover:text-cloud-50";
  return (
    <nav aria-label="Pages" className="mt-3 flex items-center justify-between gap-3 text-[0.8125rem] text-cloud-400">
      <span>
        {fmtInt((page - 1) * pageSize + 1)}–{fmtInt(Math.min(total, page * pageSize))} of {fmtInt(total)}
      </span>
      <span className="flex gap-1.5">
        {page > 1 ? (
          <Link href={href(page - 1)} className={link} scroll={false}>
            Previous
          </Link>
        ) : (
          <span className={cn(link, "pointer-events-none opacity-50")} aria-disabled>
            Previous
          </span>
        )}
        {page < pages ? (
          <Link href={href(page + 1)} className={link} scroll={false}>
            Next
          </Link>
        ) : (
          <span className={cn(link, "pointer-events-none opacity-50")} aria-disabled>
            Next
          </span>
        )}
      </span>
    </nav>
  );
}
