import { Container } from "@/components/ui/Container";
import { checkCountFor, TOTAL_CHECKS } from "@/lib/analysis/checks";
import { productStats } from "@/lib/checks";
import { PLANS } from "@/lib/plans";

/**
 * Four product facts, computed from the plan catalogue and the check
 * registry so they can never drift from what the scanner actually does.
 * Deliberately plain: a number, a label, one line of context.
 */
export function Stats() {
  const stats = productStats({
    totalChecks: TOTAL_CHECKS,
    freeChecks: checkCountFor(PLANS.free.features),
    freeScans: PLANS.free.scanLimit,
    areas: 5,
  });

  return (
    <section aria-labelledby="stats-heading" className="py-16 sm:py-20">
      <Container size="wide">
        <div className="max-w-2xl">
          <h2
            id="stats-heading"
            className="text-[2rem] font-bold leading-[1.1] tracking-[-0.025em] text-cloud-50 sm:text-[2.5rem]"
          >
            Know exactly where your site stands
          </h2>
          <p className="mt-4 text-[1.0625rem] leading-relaxed text-cloud-300">
            Clear findings and practical fixes for every website you scan.
          </p>
        </div>

        <dl className="mt-10 grid grid-cols-2 border-t border-ink-700 lg:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="border-b border-ink-700 py-6 pr-4 odd:border-r odd:pr-4 sm:pr-6 lg:border-r lg:px-6 lg:first:pl-0 lg:last:border-r-0 [&:nth-child(2)]:pl-4 [&:nth-child(4)]:pl-4 lg:[&:nth-child(2)]:pl-6 lg:[&:nth-child(4)]:pl-6"
            >
              <dt className="text-[0.9375rem] font-medium text-cloud-50">{stat.label}</dt>
              <dd className="mt-3">
                <span className="block text-[2.5rem] font-bold leading-none tracking-[-0.03em] text-azure-600 tabular-nums sm:text-[3rem]">
                  {stat.value.toLocaleString("en-IN")}
                  {stat.suffix}
                </span>
                <span className="mt-2 block text-[0.875rem] leading-snug text-cloud-400">{stat.note}</span>
              </dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
