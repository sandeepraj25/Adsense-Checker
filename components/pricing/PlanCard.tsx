import { Check, Crown, Minus, Sparkles, Zap } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { formatMoney, type Currency } from "@/lib/money";
import { checkCountFor } from "@/lib/analysis/checks";
import { FEATURE_META, planPrice, type Plan } from "@/lib/plans";

export function PlanCard({
  plan,
  currency = "INR",
  current = false,
  inherits,
  cta,
  className,
}: {
  plan: Plan;
  currency?: Currency;
  current?: boolean;
  inherits?: string;
  cta: React.ReactNode;
  className?: string;
}) {
  const featured = plan.featured;
  const free = plan.id === "free";
  const price = planPrice(plan, currency);
  const checks = checkCountFor(plan.features);
  const planName = plan.name.toLowerCase();

  return (
    <article
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-ink-700/80 bg-white p-4 text-slate-900 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-lg sm:p-5",
        featured &&
          "border-slate-800 bg-[#11151b] text-white shadow-xl hover:shadow-2xl",
        current &&
          !featured &&
          "border-azure-500 ring-1 ring-azure-500/20",
        className,
      )}
    >
      {/* Decorative corners */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-2 top-2 size-1.5 rounded-full border border-slate-300",
          featured && "border-slate-600",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute right-2 top-2 size-1.5 rounded-full border border-slate-300",
          featured && "border-slate-600",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute bottom-2 left-2 size-1.5 rounded-full border border-slate-300",
          featured && "border-slate-600",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute bottom-2 right-2 size-1.5 rounded-full border border-slate-300",
          featured && "border-slate-600",
        )}
      />

      {/* Plan heading */}
      <div className="flex items-start justify-between gap-3 px-1 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          {planName === "free" ? (
            <Zap className="size-4 shrink-0 text-amber-500" />
          ) : planName === "basic" ? (
            <Sparkles className="size-4 shrink-0 text-blue-500" />
          ) : (
            <Crown
              className={cn(
                "size-4 shrink-0",
                featured ? "text-amber-400" : "text-amber-500",
              )}
            />
          )}

          <h3
            className={cn(
              "truncate text-base font-bold tracking-tight text-slate-900",
              featured && "text-white",
            )}
          >
            {plan.name}
          </h3>
        </div>

        {current ? (
          <Badge tone="pass" dot>
            Current
          </Badge>
        ) : featured ? (
          <span className="shrink-0 rounded-full bg-orange-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
            Pro
          </span>
        ) : (
          <span
            className={cn(
              "shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600",
              featured && "border-slate-700 bg-slate-800 text-slate-200",
            )}
          >
            {free ? "Free" : "Plan"}
          </span>
        )}
      </div>

      {/* Price */}
      <div className="mt-5 px-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          {price === null ? (
            <span
              className={cn(
                "text-base font-semibold text-slate-500",
                featured && "text-slate-300",
              )}
            >
              Not available
            </span>
          ) : (
            <>
              <span
                className={cn(
                  "text-3xl font-bold leading-none tracking-tight text-slate-950 sm:text-[2rem]",
                  featured && "text-white",
                )}
              >
                {formatMoney(free ? 0 : price, currency)}
              </span>
              <span
                className={cn(
                  "text-xs text-slate-500",
                  featured && "text-slate-400",
                )}
              >
                /month
              </span>
            </>
          )}
        </div>

        <p
          className={cn(
            "mt-3 text-xs leading-5 text-slate-500",
            featured && "text-slate-400",
          )}
        >
          {plan.scanLimit} scans/month · {plan.siteLimit}{" "}
          {plan.siteLimit === 1 ? "website" : "websites"} ·{" "}
          {checks} checks
        </p>
      </div>

      {/* CTA */}
      <div
        className={cn(
          "mt-5 [&_a]:flex [&_a]:min-h-10 [&_a]:w-full [&_a]:items-center [&_a]:justify-center [&_a]:rounded-md [&_a]:text-sm [&_a]:font-semibold [&_button]:min-h-10 [&_button]:w-full [&_button]:rounded-md [&_button]:text-sm [&_button]:font-semibold",
          featured &&
            "[&_a]:border [&_a]:border-white [&_a]:bg-white [&_a]:text-slate-950 [&_a:hover]:bg-slate-100 [&_button]:border [&_button]:border-white [&_button]:bg-white [&_button]:text-slate-950",
        )}
      >
        {cta}
      </div>

      {/* Highlights */}
      {plan.highlights.length > 0 ? (
        <ul
          className={cn(
            "mt-5 space-y-2 border-t border-slate-200 pt-4",
            featured && "border-slate-700",
          )}
        >
          {plan.highlights.map((line) => (
            <li
              key={line}
              className={cn(
                "flex items-start gap-2 text-xs leading-5 text-slate-600",
                featured && "text-slate-300",
              )}
            >
              <Check
                className={cn(
                  "mt-0.5 size-3.5 shrink-0 text-slate-500",
                  featured && "text-slate-300",
                )}
              />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Features */}
      <div
        className={cn(
          "mt-4 flex-1 border-t border-slate-200 pt-4",
          featured && "border-slate-700",
        )}
      >
        {inherits ? (
          <p
            className={cn(
              "mb-3 text-xs font-semibold text-slate-600",
              featured && "text-slate-300",
            )}
          >
            Everything in {inherits}, plus:
          </p>
        ) : null}

        <ul className="space-y-2.5">
          {plan.showcase.map((feature) => (
            <li
              key={feature}
              className="flex items-start gap-2.5"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                  featured ? "border border-slate-500" : "border border-slate-300",
                )}
              >
                <Check
                  className={cn(
                    "size-2.5",
                    featured ? "text-slate-200" : "text-slate-500",
                  )}
                  strokeWidth={2.5}
                />
              </span>

              <span
                className={cn(
                  "text-xs leading-[1.6] text-slate-600 sm:text-[13px]",
                  featured && "text-slate-300",
                )}
              >
                {FEATURE_META[feature].label}
              </span>
            </li>
          ))}

          {plan.excluded.map((feature) => (
            <li
              key={feature}
              className="flex items-start gap-2.5"
            >
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-slate-200">
                <Minus className="size-2.5 text-slate-400" />
              </span>

              <span
                className={cn(
                  "text-xs leading-[1.6] text-slate-400 sm:text-[13px]",
                  featured && "text-slate-500",
                )}
              >
                {FEATURE_META[feature].label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
