import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  XCircle,
} from "lucide-react";

import { Container } from "@/components/ui/Container";
import { cn } from "@/lib/cn";

/**
 * What the scanner looks at, and what a finished report reads like.
 *
 * Replaces the earlier five-column animated "scanner": a looping timer
 * that revealed tiny status pills along a horizontal progress line. The
 * same content is here, but static and legible — the check areas as a
 * list, and one example report beside them. The example is labelled as
 * illustrative because it is: it is not a real scan of a real site.
 */

const areas = [
  {
    icon: FileText,
    title: "Required pages",
    body: "Privacy policy, terms and a way to contact you — the pages reviewers look for first.",
  },
  {
    icon: Search,
    title: "Content quality",
    body: "Thin pages, duplicated text and content that reads as machine-written.",
  },
  {
    icon: Settings2,
    title: "Technical setup",
    body: "HTTPS, ads.txt, robots rules and whether a crawler can reach your pages.",
  },
  {
    icon: Smartphone,
    title: "Mobile experience",
    body: "Whether the layout fits a phone screen and loads in reasonable time.",
  },
  {
    icon: ShieldCheck,
    title: "Policy signals",
    body: "Content and placements that commonly lead to a rejection.",
  },
] as const;

type Status = "pass" | "warn" | "fail";

const findings: { status: Status; area: string; text: string }[] = [
  { status: "fail", area: "Required pages", text: "No contact page found" },
  { status: "fail", area: "Technical setup", text: "ads.txt is missing" },
  { status: "warn", area: "Content quality", text: "3 pages have under 300 words" },
  { status: "warn", area: "Mobile experience", text: "Content overflows on small screens" },
  { status: "pass", area: "Technical setup", text: "HTTPS is configured" },
  { status: "pass", area: "Required pages", text: "Privacy policy found" },
];

const statusMeta: Record<Status, { icon: typeof CheckCircle2; label: string; tone: string }> = {
  fail: { icon: XCircle, label: "Blocker", tone: "text-rose-400" },
  warn: { icon: AlertTriangle, label: "Improve", tone: "text-amber-400" },
  pass: { icon: CheckCircle2, label: "Passed", tone: "text-mint-400" },
};

export function Features() {
  const counts = {
    fail: findings.filter((f) => f.status === "fail").length,
    warn: findings.filter((f) => f.status === "warn").length,
    pass: findings.filter((f) => f.status === "pass").length,
  };

  return (
    <section id="features" className="scroll-mt-24 border-t border-ink-700 bg-ink-900 py-16 sm:py-20">
      <Container size="wide">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16">
          {/* What is checked */}
          <div>
            <h2 className="max-w-lg text-[2rem] font-bold leading-[1.1] tracking-[-0.025em] text-cloud-50 sm:text-[2.5rem]">
              Your site is checked the way a reviewer would look at it
            </h2>
            <p className="mt-4 max-w-lg text-[1.0625rem] leading-relaxed text-cloud-300">
              Every scan covers five areas. Each problem it finds comes with
              the page it is on and what to change.
            </p>

            <ul className="mt-10 divide-y divide-ink-700 border-y border-ink-700">
              {areas.map((area) => (
                <li key={area.title} className="flex gap-4 py-4">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-ink-700 bg-white text-azure-600">
                    <area.icon className="size-[1.125rem]" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[1rem] font-semibold text-cloud-50">{area.title}</h3>
                    <p className="mt-1 text-[0.9375rem] leading-relaxed text-cloud-400">{area.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Example report */}
          <figure className="self-start lg:sticky lg:top-28">
            <div className="overflow-hidden rounded-xl border border-ink-700 bg-white shadow-[0_24px_60px_-32px_rgba(24,24,27,0.35)]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 px-5 py-4 sm:px-6">
                <div className="min-w-0">
                  <p className="text-[0.8125rem] text-cloud-400">Example report</p>
                  <p className="t-data truncate text-[1rem] text-cloud-50">example-blog.com</p>
                </div>
                <span className="rounded-md border border-amber-400/25 bg-amber-400/[0.07] px-2.5 py-1 text-[0.8125rem] font-medium text-amber-400">
                  Needs improvement
                </span>
              </div>

              <div className="grid grid-cols-3 border-b border-ink-700 text-center">
                {(["fail", "warn", "pass"] as const).map((key) => (
                  <div key={key} className="border-r border-ink-700 px-3 py-4 last:border-r-0">
                    <p className={cn("text-[1.5rem] font-semibold leading-none tabular-nums", statusMeta[key].tone)}>
                      {counts[key]}
                    </p>
                    <p className="mt-1.5 text-[0.8125rem] text-cloud-400">
                      {key === "fail" ? "Blockers" : key === "warn" ? "To improve" : "Passed"}
                    </p>
                  </div>
                ))}
              </div>

              <ul className="divide-y divide-ink-850">
                {findings.map((finding) => {
                  const meta = statusMeta[finding.status];
                  return (
                    <li key={finding.text} className="flex items-start gap-3 px-5 py-3.5 sm:px-6">
                      <meta.icon className={cn("mt-0.5 size-[1.125rem] shrink-0", meta.tone)} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-[0.9375rem] text-cloud-50">{finding.text}</p>
                        <p className="mt-0.5 text-[0.8125rem] text-cloud-400">{finding.area}</p>
                      </div>
                      <span className={cn("shrink-0 text-[0.8125rem] font-medium", meta.tone)}>
                        <span className="sr-only">Status: </span>
                        {meta.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <figcaption className="mt-3 text-[0.8125rem] text-cloud-400">
              Illustrative example of the report layout — not a real scan.
            </figcaption>
          </figure>
        </div>
      </Container>
    </section>
  );
}
