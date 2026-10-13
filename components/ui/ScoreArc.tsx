"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { CountUp } from "./CountUp";

/**
 * Custom SVG eligibility gauge — the product's core output, and the
 * page's signature object. A 260° arc with real tick marks: the ones
 * the score has passed light up, so the dial reads as a measurement
 * instrument rather than a decorative ring.
 */
export function ScoreArc({
  value,
  size = 168,
  stroke = 10,
  verdict,
  replayKey = 0,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  verdict?: string;
  replayKey?: number;
  className?: string;
}) {
  // Sanitised so the id is always safe inside url(#...) references,
  // regardless of how the React version formats useId output.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const reduce = useReducedMotion();

  const cx = size / 2;
  const cy = size / 2;
  const r = (size - stroke * 2 - 12) / 2;
  const circumference = 2 * Math.PI * r;

  const GAP_DEG = 100;
  const SWEEP_DEG = 360 - GAP_DEG;
  const START_DEG = 90 + GAP_DEG / 2;

  const arcLength = circumference * (SWEEP_DEG / 360);
  const pct = Math.min(Math.max(value, 0), 100) / 100;

  const tickRadius = r + stroke / 2 + 6;
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const theta = ((START_DEG + (SWEEP_DEG * i) / 10) * Math.PI) / 180;
    const inner = tickRadius - (i % 5 === 0 ? 5 : 3);
    return {
      passed: i / 10 <= pct + 0.001,
      x1: cx + inner * Math.cos(theta),
      y1: cy + inner * Math.sin(theta),
      x2: cx + tickRadius * Math.cos(theta),
      y2: cy + tickRadius * Math.sin(theta),
      major: i % 5 === 0,
    };
  });

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Eligibility score ${value} out of 100${
        verdict ? `, ${verdict}` : ""
      }`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={`arc-${uid}`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#6366F1" />
            <stop offset="52%" stopColor="#4F46E5" />
            <stop offset="100%" stopColor="#4338CA" />
          </linearGradient>
        </defs>

        {/* tick ring */}
        <g strokeWidth={1.25} strokeLinecap="round">
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.passed ? "#818CF8" : "#E4E4E7"}
              opacity={t.passed ? (t.major ? 0.95 : 0.6) : 0.75}
            />
          ))}
        </g>

        <g transform={`rotate(${START_DEG} ${cx} ${cy})`}>
          {/* track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="#EEF0F4"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${circumference}`}
          />

          {/* progress arc */}
          <motion.circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={`url(#arc-${uid})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${circumference}`}
            initial={{ strokeDashoffset: arcLength }}
            animate={{ strokeDashoffset: arcLength * (1 - pct) }}
            transition={{
              duration: reduce ? 0 : 1.5,
              ease: [0.16, 1, 0.3, 1],
              delay: reduce ? 0 : 0.25,
            }}
            key={`arc-run-${replayKey}`}
          />
        </g>
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="flex items-start gap-0.5">
          <span
            className="t-display tabular-nums"
            style={{ fontSize: size * 0.28, lineHeight: 1 }}
          >
            <CountUp key={`n-${replayKey}`} to={value} duration={1.5} />
          </span>
          <span
            className="t-data mt-1 text-cloud-600"
            style={{ fontSize: size * 0.085 }}
          >
            /100
          </span>
        </div>
        {verdict ? (
          <span
            className="t-eyebrow mt-1.5 text-amber-400"
            style={{ fontSize: size * 0.062 }}
          >
            {verdict}
          </span>
        ) : null}
      </div>
    </div>
  );
}
