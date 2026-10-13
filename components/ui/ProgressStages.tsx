"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

/**
 * The ten stages a run walks through, in the order the engine performs
 * them. The engine does this work in a single server round-trip, so the
 * client cannot subscribe to real stage events — the walk is paced
 * locally and *holds* on the final stage until the request actually
 * resolves. Nothing here claims a stage passed: completion is only ever
 * marked when the server answers.
 */
export const ANALYSIS_STAGES = [
  "Connecting to website",
  "Checking accessibility",
  "Scanning content structure",
  "Checking SEO elements",
  "Checking navigation",
  "Checking mobile readiness",
  "Checking privacy and legal pages",
  "Checking technical health",
  "Calculating eligibility score",
  "Generating recommendations",
] as const;

/** Uneven pacing — a real crawl is slow to connect, quick to tally. */
const STAGE_MS = [1500, 1200, 2300, 1300, 1500, 1000, 1600, 1400, 900, 900];

export type StagePhase = "idle" | "running" | "done" | "failed";

export type StageProgress = {
  phase: StagePhase;
  index: number;
  start: () => void;
  finish: () => void;
  fail: () => void;
  reset: () => void;
};

export function useStageProgress(): StageProgress {
  const [phase, setPhase] = useState<StagePhase>("idle");
  const [index, setIndex] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    if (phase !== "running") return;
    // Hold on the last stage rather than looping or finishing early.
    if (index >= ANALYSIS_STAGES.length - 1) return;

    timer.current = setTimeout(
      () => setIndex((i) => Math.min(i + 1, ANALYSIS_STAGES.length - 1)),
      STAGE_MS[index] ?? 1200,
    );
    return clear;
  }, [phase, index, clear]);

  useEffect(() => clear, [clear]);

  return {
    phase,
    index,
    start: useCallback(() => {
      clear();
      setIndex(0);
      setPhase("running");
    }, [clear]),
    finish: useCallback(() => {
      clear();
      setIndex(ANALYSIS_STAGES.length - 1);
      setPhase("done");
    }, [clear]),
    fail: useCallback(() => {
      clear();
      setPhase("failed");
    }, [clear]),
    reset: useCallback(() => {
      clear();
      setIndex(0);
      setPhase("idle");
    }, [clear]),
  };
}

/* ── view ───────────────────────────────────────────────────────── */

export function ProgressStages({
  phase,
  index,
  target,
  className,
}: {
  phase: StagePhase;
  index: number;
  /** The domain being audited, shown as the subject of the run. */
  target?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const total = ANALYSIS_STAGES.length;
  const settled = phase === "done" || phase === "failed";
  const completed = phase === "done" ? total : index;
  const pct = Math.round((completed / total) * 100);

  return (
    <div
      className={cn(
        "glass edge-light relative overflow-hidden rounded-xl p-5 sm:p-6",
        className,
      )}
      aria-busy={phase === "running"}
    >
      {/* One pass of the product's signature sweep as the run opens. */}
      {phase === "running" && index === 0 ? (
        <span aria-hidden className="scan-sweep" />
      ) : null}

      <div className="relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="t-eyebrow text-cloud-600">
          {phase === "failed"
            ? "Run stopped"
            : phase === "done"
              ? "Run complete"
              : "Running 34 checks"}
        </p>
        {target ? (
          <p className="t-data max-w-full truncate text-[0.8125rem] text-cloud-400">
            {target}
          </p>
        ) : null}
      </div>

      {/* Track */}
      <div className="relative mt-4 h-1 overflow-hidden rounded-full bg-ink-900">
        <motion.span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            phase === "failed" ? "bg-rose-400/70" : "grad-brand",
          )}
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(pct, 4)}%` }}
          transition={{
            duration: reduce ? 0 : 0.6,
            ease: [0.16, 1, 0.3, 1],
          }}
        />
      </div>

      <p className="t-data mt-2.5 text-[0.75rem] text-cloud-600">
        {phase === "done"
          ? `${total} / ${total} stages`
          : `${Math.min(completed + (settled ? 0 : 1), total)} / ${total} stages`}
      </p>

      {/* Stage list */}
      <ol className="mt-5 space-y-0.5">
        {ANALYSIS_STAGES.map((label, i) => {
          const isDone = phase === "done" || i < index;
          const isActive = !settled && i === index;
          const isFailed = phase === "failed" && i === index;

          return (
            <li
              key={label}
              className={cn(
                "flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-300",
                isActive && "bg-ink-900",
              )}
            >
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full ring-1 transition-colors duration-300",
                  isFailed
                    ? "bg-rose-400/12 text-rose-400 ring-rose-400/30"
                    : isDone
                      ? "bg-mint-400/12 text-mint-400 ring-mint-400/30"
                      : isActive
                        ? "bg-azure-500/12 text-azure-600 ring-azure-400/35"
                        : "text-cloud-600 ring-white/10",
                )}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {isFailed ? (
                    <motion.span
                      key="fail"
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: reduce ? 0 : 0.24 }}
                    >
                      <X className="size-3" strokeWidth={3} />
                    </motion.span>
                  ) : isDone ? (
                    <motion.span
                      key="done"
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: reduce ? 0 : 0.24 }}
                    >
                      <Check className="size-3" strokeWidth={3.2} />
                    </motion.span>
                  ) : isActive ? (
                    <Spinner key="run" className="size-3 border-[1.5px]" label={label} />
                  ) : (
                    <span
                      key="idle"
                      className="size-1 rounded-full bg-current opacity-70"
                    />
                  )}
                </AnimatePresence>
              </span>

              <span
                className={cn(
                  "text-[0.875rem] transition-colors duration-300",
                  isFailed
                    ? "text-rose-400"
                    : isActive
                      ? "font-medium text-cloud-50"
                      : isDone
                        ? "text-cloud-200"
                        : "text-cloud-600",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
