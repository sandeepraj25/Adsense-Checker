"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Radar, ShieldAlert } from "lucide-react";
import { ScoreArc } from "@/components/ui/ScoreArc";
import { StatusIcon, StatusPill } from "@/components/ui/Status";
import { heroChecks } from "@/lib/checks";

/**
 * THE SIGNATURE ELEMENT.
 *
 * Not a screenshot in a browser frame: the product's own output, running
 * itself. A sweep crosses the panel, checks land one at a time, and the
 * dial settles on 72 — deliberately an imperfect score, because the
 * interesting question for a visitor is what their own number would be.
 */
export function AuditCard() {
  const reduce = useReducedMotion();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (reduce) {
      setDone(true);
      return;
    }
    const timer = window.setTimeout(() => setDone(true), 2500);
    return () => window.clearTimeout(timer);
  }, [reduce]);

  return (
    <div className="relative">
      {/* cast glow */}
      <div
        aria-hidden
        className="absolute -inset-8 -z-10 rounded-xl bg-[radial-gradient(60%_60%_at_60%_40%,rgba(124,92,255,0.3),transparent_70%)] blur-2xl"
      />

      <motion.div
        initial={reduce ? undefined : { opacity: 0, y: 26, rotateX: 6 }}
        animate={reduce ? undefined : { opacity: 1, y: 0, rotateX: 0 }}
        transition={{ duration: 0.95, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        className="glass grad-hairline edge-light relative overflow-hidden rounded-[1.75rem]"
      >
        {!reduce ? <span className="scan-sweep z-20" aria-hidden /> : null}

        {/* chrome */}
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex gap-1.5" aria-hidden>
              <span className="size-2 rounded-full bg-ink-900" />
              <span className="size-2 rounded-full bg-ink-900" />
              <span className="size-2 rounded-full bg-ink-900" />
            </span>
            <span className="t-data text-[0.75rem] text-cloud-600">
              eligibility report
            </span>
          </div>

          <span className="t-data flex items-center gap-1.5 text-[0.75rem] text-cloud-400">
            {done ? (
              <>
                <span className="relative flex size-1.5" aria-hidden>
                  <span className="absolute inset-0 rounded-full bg-mint-400/60 pulse-ring" />
                  <span className="relative size-1.5 rounded-full bg-mint-400" />
                </span>
                18.2s
              </>
            ) : (
              <>
                <Radar className="size-3 animate-pulse text-azure-400" aria-hidden />
                scanning
              </>
            )}
          </span>
        </div>

        {/* verdict head */}
        <div className="flex items-center gap-5 px-5 pb-5 pt-6 sm:gap-7 sm:px-7">
          <ScoreArc value={72} size={148} verdict="Needs work" />

          <div className="min-w-0 flex-1">
            <p className="t-data truncate text-[0.8125rem] text-cloud-200">
              northfield.blog
            </p>
            <p className="t-display mt-2 text-[1.35rem] leading-tight">
              Not ready
              <br />
              to apply yet
            </p>

            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
              <Legend count={27} label="passed" tone="text-mint-400" />
              <Legend count={4} label="to fix" tone="text-amber-400" />
              <Legend count={3} label="blockers" tone="text-rose-400" />
            </div>
          </div>
        </div>

        {/* streamed checks */}
        <motion.ul
          className="border-t border-ink-700"
          initial="hidden"
          animate="shown"
          variants={{
            shown: { transition: { staggerChildren: reduce ? 0 : 0.13, delayChildren: reduce ? 0 : 0.5 } },
          }}
        >
          {heroChecks.map((check) => (
            <motion.li
              key={check.label}
              variants={{
                hidden: reduce ? {} : { opacity: 0, x: -10 },
                shown: reduce ? {} : { opacity: 1, x: 0 },
              }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-3 border-b border-ink-700 px-5 py-2.5 last:border-b-0 sm:px-7"
            >
              <StatusIcon status={check.status} />
              <span className="flex-1 truncate text-[0.875rem] text-cloud-200">
                {check.label}
              </span>
              <StatusPill status={check.status} />
            </motion.li>
          ))}
        </motion.ul>
      </motion.div>

      {/* orbiting detail chips — tell the two facts the dial can't */}
      <motion.div
        aria-hidden
        initial={reduce ? undefined : { opacity: 0, scale: 0.9 }}
        animate={reduce ? undefined : { opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, delay: 1.5, ease: [0.16, 1, 0.3, 1] }}
        className="glass absolute -left-4 top-[46%] hidden items-center gap-2 rounded-xl px-3 py-2 shadow-sm lg:flex"
      >
        <ShieldAlert className="size-3.5 text-rose-400" />
        <span className="t-data text-[0.75rem] text-cloud-200">
          contact page missing
        </span>
      </motion.div>

      <motion.div
        aria-hidden
        initial={reduce ? undefined : { opacity: 0, scale: 0.9 }}
        animate={reduce ? undefined : { opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, delay: 1.8, ease: [0.16, 1, 0.3, 1] }}
        className="glass absolute -right-3 top-6 hidden flex-col rounded-xl px-3.5 py-2.5 shadow-sm lg:flex"
      >
        <span className="text-[0.8125rem] font-medium text-cloud-600">
          policy set
        </span>
        <span className="t-data mt-1 text-[0.8125rem] text-cloud-50">
          34 checks
        </span>
      </motion.div>
    </div>
  );
}

function Legend({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`t-data text-[0.9375rem] font-medium ${tone}`}>
        {count}
      </span>
      <span className="text-[0.8125rem] text-cloud-600">{label}</span>
    </span>
  );
}
