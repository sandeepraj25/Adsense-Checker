import { Container } from "@/components/ui/Container";

/**
 * The three-step loop. A genuine sequence, so it is numbered: a row on
 * wide screens, a vertical timeline on narrow ones.
 *
 * Replaces three cards that hotlinked stock photos from third-party sites
 * (slow, unreliable, and unrelated to the product). The copy is also
 * corrected: a scan does need a free account, and the crawl depth is set
 * by the server (ANALYSIS_MAX_PAGES), so no page count is promised here.
 */
const steps = [
  {
    title: "Enter your website",
    body: "Type your domain and create a free account. There is nothing to install on your site and no DNS change to make.",
  },
  {
    title: "We review it like an AdSense reviewer",
    body: "Your homepage and key pages are checked for required pages, content quality, technical setup, mobile layout and policy signals.",
  },
  {
    title: "Fix the blockers and apply",
    body: "Each issue names the page it is on and the change to make. Fix them, scan again to confirm, then apply.",
  },
];

export function Process() {
  return (
    <section id="process" className="scroll-mt-24 py-16 sm:py-20">
      <Container size="wide">
        <div className="max-w-2xl">
          <h2 className="text-[2rem] font-bold leading-[1.1] tracking-[-0.025em] text-cloud-50 sm:text-[2.5rem]">
            Three steps from your domain to a clean application
          </h2>
          <p className="mt-4 text-[1.0625rem] leading-relaxed text-cloud-300">
            Most sites need one round of fixes. Scan again any time to check
            your progress.
          </p>
        </div>

        <ol className="mt-12 grid gap-0 md:grid-cols-3 md:gap-8">
          {steps.map((step, index) => (
            <li key={step.title} className="relative flex gap-5 pb-10 last:pb-0 md:flex-col md:gap-0 md:pb-0">
              {/* Vertical connector on phones only; on wide screens the
                  numbers sit in a row and need no line between them. */}
              {index < steps.length - 1 ? (
                <span aria-hidden className="absolute left-[1.1875rem] top-11 bottom-1 w-px bg-ink-700 md:hidden" />
              ) : null}

              <span className="relative grid size-10 shrink-0 place-items-center rounded-full border border-azure-500/25 bg-white text-[0.9375rem] font-semibold text-azure-600">
                {index + 1}
              </span>

              <div className="min-w-0 md:mt-5 md:border-t md:border-ink-700 md:pt-5">
                <h3 className="text-[1.125rem] font-semibold leading-snug text-cloud-50">{step.title}</h3>
                <p className="mt-2 max-w-sm text-[0.9375rem] leading-relaxed text-cloud-400">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
