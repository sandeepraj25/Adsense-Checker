"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { formatMoney } from "@/lib/money";
import { fmtInt } from "./format";

export type ChartSeries = { name: string; values: number[]; color: string };
export type ChartFormat = "int" | "INR" | "USD";

function fmt(value: number, format: ChartFormat): string {
  return format === "int" ? fmtInt(value) : formatMoney(value, format);
}

/** A top for the y axis that splits into four whole-number steps. */
function niceMax(max: number): number {
  if (max <= 4) return 4;
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const value = step * pow;
    if (value >= raw && Number.isInteger(value)) return value * 4;
  }
  return 40 * pow;
}

const DEFAULT_W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

/**
 * A line chart for a few series over the same buckets. Hover, tap or use
 * the arrow keys to read exact values; the numbers are also available as
 * a table underneath for screen readers and for copying.
 */
export function TrendChart({
  labels,
  series,
  format = "int",
  title,
  emptyText = "No data in this period.",
}: {
  labels: string[];
  series: ChartSeries[];
  format?: ChartFormat;
  title: string;
  emptyText?: string;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  // Draw at the real pixel width so axis text stays a readable size in
  // narrow panels instead of being scaled down with the whole chart.
  const [W, setW] = useState(DEFAULT_W);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width > 0) setW(Math.max(280, width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = labels.length;
  const max = useMemo(() => niceMax(Math.max(0, ...series.flatMap((s) => s.values))), [series]);
  const hasData = series.some((s) => s.values.some((v) => v > 0));

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 72))));

  if (n === 0 || !hasData) {
    return (
      <div className="grid h-40 place-items-center rounded-md border border-dashed border-ink-700 px-4 text-center text-[0.875rem] text-cloud-400">
        {emptyText}
      </div>
    );
  }

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{title}</figcaption>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-hidden>
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-[0.8125rem] text-cloud-300">
            <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <div
        ref={box}
        className="relative rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the left and right arrow keys to read values.`}
        aria-describedby={`${id}-live`}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") setActive((a) => Math.min(n - 1, a === null ? 0 : a + 1));
          else if (event.key === "ArrowLeft") setActive((a) => Math.max(0, a === null ? n - 1 : a - 1));
          else if (event.key === "Escape") setActive(null);
          else return;
          event.preventDefault();
        }}
        onBlur={() => setActive(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full touch-pan-y"
          aria-hidden
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const vx = ((event.clientX - rect.left) / rect.width) * W;
            const i = n <= 1 ? 0 : Math.round(((vx - PAD.left) / innerW) * (n - 1));
            setActive(Math.min(n - 1, Math.max(0, i)));
          }}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e4e4e7" strokeDasharray={t === 0 ? undefined : "3 4"} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#71717a">
                {format === "int" ? fmtInt(t) : fmt(t, format).replace(/\.00$/, "")}
              </text>
            </g>
          ))}
          {labels.map((label, i) =>
            (i % labelEvery === 0 && (i === n - 1 || n - 1 - i >= labelEvery * 0.75)) || i === n - 1 ? (
              <text key={`${label}-${i}`} x={x(i)} y={H - 8} textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"} fontSize="11" fill="#71717a">
                {label}
              </text>
            ) : null,
          )}
          {active !== null ? <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + innerH} stroke="#a1a1aa" /> : null}
          {series.map((s) => (
            <g key={s.name}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              />
              {n <= 45 || active !== null
                ? s.values.map((v, i) =>
                    n <= 45 || i === active ? <circle key={i} cx={x(i)} cy={y(v)} r={i === active ? 4 : 2.5} fill="#fff" stroke={s.color} strokeWidth={2} /> : null,
                  )
                : null}
            </g>
          ))}
        </svg>
        {active !== null ? (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-ink-700 bg-white px-3 py-2 text-[0.8125rem] shadow-[0_8px_24px_rgba(24,24,27,0.12)]"
            style={{
              left: `${(x(active) / W) * 100}%`,
              transform: `translateX(${x(active) / W > 0.6 ? "calc(-100% - 10px)" : "10px"})`,
            }}
          >
            <p className="font-semibold text-cloud-50">{labels[active]}</p>
            {series.map((s) => (
              <p key={s.name} className="mt-0.5 flex items-center justify-between gap-4 text-cloud-300">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: s.color }} />
                  {s.name}
                </span>
                <span className="t-data font-medium text-cloud-50">{fmt(s.values[active] ?? 0, format)}</span>
              </p>
            ))}
          </div>
        ) : null}
        <p id={`${id}-live`} className="sr-only" aria-live="polite">
          {active !== null ? `${labels[active]}: ${series.map((s) => `${s.name} ${fmt(s.values[active] ?? 0, format)}`).join(", ")}` : ""}
        </p>
      </div>
      <details className="mt-2 text-[0.8125rem] text-cloud-400">
        <summary className="cursor-pointer select-none hover:text-cloud-50">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-ink-700">
                <th scope="col" className="py-1.5 pr-3 font-medium">Period</th>
                {series.map((s) => (
                  <th key={s.name} scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((label, i) => (
                <tr key={`${label}-${i}`} className="border-b border-ink-850 last:border-0">
                  <td className="py-1 pr-3 text-cloud-200">{label}</td>
                  {series.map((s) => (
                    <td key={s.name} className="t-data py-1 pr-3 text-right text-cloud-200">
                      {fmt(s.values[i] ?? 0, format)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
