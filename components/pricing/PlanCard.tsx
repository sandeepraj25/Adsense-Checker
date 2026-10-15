
import { Check, Crown, Minus, Sparkles, Zap } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { formatMoney, type Currency } from "@/lib/money";
import { checkCountFor } from "@/lib/analysis/checks";
import { FEATURE_META, planPrice, type Plan } from "@/lib/plans";
import type { BillingCycle } from "@/lib/billing/cycle";
import type { YearlyOffer } from "@/lib/billing/offer";

export function PlanCard({
  plan,
  currency = "INR",
  current = false,
  inherits,
  cta,
  className,
  cycle = "monthly",
  yearly = null,
}: {
  plan: Plan;
  currency?: Currency;
  cycle?: BillingCycle;
  yearly?: YearlyOffer | null;
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
        "relative flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border p-6 transition-all duration-300 hover:-translate-y-1 sm:p-7",
        featured
          ? "border-violet-600 bg-violet-600 text-white shadow-xl shadow-violet-600/20 hover:shadow-2xl hover:shadow-violet-600/25"
          : "border-slate-200 bg-white text-slate-900 shadow-sm hover:border-slate-300 hover:shadow-xl",
        current && !featured && "border-violet-500 ring-2 ring-violet-500/15",
        className,
      )}
    >
      {/* Plan heading */}
      <div className="flex min-h-8 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {planName === "free" ? (
            <Zap
              aria-hidden="true"
              className={cn(
                "size-5 shrink-0",
                featured ? "text-violet-100" : "text-amber-500",
              )}
            />
          ) : planName === "basic" ? (
            <Sparkles
              aria-hidden="true"
              className={cn(
                "size-5 shrink-0",
                featured ? "text-violet-100" : "text-blue-500",
              )}
            />
          ) : (
            <Crown
              aria-hidden="true"
              className={cn(
                "size-5 shrink-0",
                featured ? "text-white" : "text-violet-600",
              )}
            />
          )}

          <h3
            className={cn(
              "truncate text-xl font-semibold tracking-tight",
              featured ? "text-white" : "text-slate-950",
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
          <span className="shrink-0 rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-violet-700">
            Most Popular
          </span>
        ) : null}
      </div>

      {/* Plan description */}
      {plan.tagline ? (
        <p
          className={cn(
            "mt-3 min-h-10 text-sm leading-6",
            featured ? "text-violet-100" : "text-slate-500",
          )}
        >
          {plan.tagline}
        </p>
      ) : null}

      {/* Price */}
      <div className="mt-6">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {price === null ? (
            <span
              className={cn(
                "text-lg font-semibold",
                featured ? "text-violet-100" : "text-slate-500",
              )}
            >
              Not available
            </span>
          ) : yearly && !free ? (
            <>
              <span className="text-4xl font-semibold leading-none tracking-tight sm:text-[2.75rem]">
                {formatMoney(yearly.price, currency)}
              </span>
              <span
                className={cn(
                  "text-sm",
                  featured ? "text-violet-100" : "text-slate-500",
                )}
              >
                /year
              </span>
            </>
          ) : (
            <>
              <span className="text-4xl font-semibold leading-none tracking-tight sm:text-[2.75rem]">
                {formatMoney(free ? 0 : price, currency)}
              </span>
              <span
                className={cn(
                  "text-sm",
                  featured ? "text-violet-100" : "text-slate-500",
                )}
              >
                /month
              </span>
            </>
          )}
        </div>

        {cycle === "yearly" && !free && price !== null ? (
          <p
            className={cn(
              "mt-3 flex flex-wrap items-center gap-2 text-xs leading-5",
              featured ? "text-violet-100" : "text-slate-500",
            )}
          >
            {yearly ? (
              <>
                <span>
                  ≈ {formatMoney(yearly.perMonth, currency)}/month, billed
                  yearly
                </span>

                {yearly.discount ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      featured
                        ? "bg-white/15 text-white"
                        : "bg-emerald-50 text-emerald-700",
                    )}
                  >
                    Save {yearly.discount}%
                  </span>
                ) : null}

                {yearly.badge ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      featured
                        ? "bg-white/15 text-white"
                        : "bg-violet-50 text-violet-700",
                    )}
                  >
                    {yearly.badge}
                  </span>
                ) : null}
              </>
            ) : (
              <span>Billed monthly — no yearly option for this plan</span>
            )}
          </p>
        ) : null}

        {/* Existing plan limits */}
        <p
          className={cn(
            "mt-4 text-xs leading-5",
            featured ? "text-violet-100" : "text-slate-500",
          )}
        >
          {plan.scanLimit} scans/month · {plan.pagesPerScan}{" "}
          {plan.pagesPerScan === 1 ? "page" : "pages"}/scan · {plan.siteLimit}{" "}
          {plan.siteLimit === 1 ? "website" : "websites"} · {checks} checks
        </p>
      </div>

      {/* Existing CTA / checkout action */}
      <div
        className={cn(
          "mt-6 [&_a]:flex [&_a]:min-h-11 [&_a]:w-full [&_a]:items-center [&_a]:justify-center [&_a]:rounded-lg [&_a]:px-4 [&_a]:text-sm [&_a]:font-semibold [&_a]:transition-colors [&_button]:min-h-11 [&_button]:w-full [&_button]:rounded-lg [&_button]:px-4 [&_button]:text-sm [&_button]:font-semibold [&_button]:transition-colors",
          featured
            ? "[&_a]:border [&_a]:border-white [&_a]:bg-white [&_a]:text-violet-700 [&_a:hover]:bg-violet-50 [&_button]:border [&_button]:border-white [&_button]:bg-white [&_button]:text-violet-700 [&_button:hover]:bg-violet-50"
            : "[&_a]:border [&_a]:border-violet-100 [&_a]:bg-violet-50 [&_a]:text-violet-700 [&_a:hover]:border-violet-200 [&_a:hover]:bg-violet-100 [&_button]:border [&_button]:border-violet-100 [&_button]:bg-violet-50 [&_button]:text-violet-700 [&_button:hover]:bg-violet-100",
        )}
      >
        {cta}
      </div>

      {/* Admin-configured highlights */}
      {plan.highlights.length > 0 ? (
        <ul
          className={cn(
            "mt-6 space-y-2.5 border-t pt-5",
            featured ? "border-white/20" : "border-slate-100",
          )}
        >
          {plan.highlights.map((line, index) => (
            <li
              key={`${line}-${index}`}
              className={cn(
                "flex items-start gap-2.5 text-sm leading-5",
                featured ? "text-violet-50" : "text-slate-600",
              )}
            >
              <Check
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  featured ? "text-white" : "text-violet-600",
                )}
              />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Admin-configured included / excluded features */}
      <div
        className={cn(
          "mt-5 flex-1 border-t pt-5",
          featured ? "border-white/20" : "border-slate-100",
        )}
      >
        {inherits ? (
          <p
            className={cn(
              "mb-4 text-sm font-bold leading-5",
              featured ? "text-violet-100" : "text-slate-600",
            )}
          >
            Everything in {inherits}, plus:
          </p>
        ) : null}

        <ul className="space-y-3">
          {plan.showcase.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full",
                  featured
                    ? "bg-white/15 text-white"
                    : "bg-violet-50 text-violet-700",
                )}
              >
                <Check
                  aria-hidden="true"
                  className="size-3"
                  strokeWidth={2.5}
                />
              </span>

              <span
                className={cn(
                  "text-sm leading-[1.65]",
                  featured ? "text-white" : "text-slate-600",
                )}
              >
                {FEATURE_META[feature].label}
              </span>
            </li>
          ))}

          {plan.excluded.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                  featured
                    ? "border-white/20 text-violet-200"
                    : "border-slate-200 text-slate-400",
                )}
              >
                <Minus aria-hidden="true" className="size-3" />
              </span>

              <span
                className={cn(
              "text-sm font-semibold leading-[1.65]",
featured ? "text-white" : "text-slate-600",
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
