import { Check } from "lucide-react";

import { Container } from "@/components/ui/Container";
import { Navbar } from "@/components/sections/Navbar";

/**
 * Login and signup frame: the form in a card, and — on wide screens — the
 * short list of what the account gives you, from each page's `proof`
 * prop (it was accepted but never shown before). The form comes first in
 * the reading order, so on phones it is at the top.
 */
export function AuthShell({
  title,
  lede,
  children,
  footer,
  proof,
}: {
  title: React.ReactNode;
  lede: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  proof: string[];
}) {
  return (
    <main className="relative min-h-screen bg-ink-900">
      <Navbar viewer={null} />

      <Container size="default" className="flex min-h-screen items-center pt-28 pb-12">
        <div className="grid w-full items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:gap-16">
          <div className="order-2 hidden lg:order-1 lg:block">
            <p className="text-[0.875rem] font-semibold text-azure-600">AdSense Checker</p>
            <h2 className="mt-2 max-w-md text-[1.75rem] font-bold leading-tight tracking-tight text-cloud-50">
              Find what would get your site rejected before Google does.
            </h2>
            {proof.length > 0 ? (
              <ul className="mt-8 space-y-3.5">
                {proof.map((line) => (
                  <li key={line} className="flex gap-3 text-[0.9375rem] leading-relaxed text-cloud-200">
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-mint-400/[0.1]">
                      <Check className="size-3 text-mint-400" strokeWidth={3} aria-hidden />
                    </span>
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="order-1 w-full lg:order-2">
            <div className="rounded-xl border border-ink-700 bg-white p-6 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:p-8">
              <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-cloud-50">{title}</h1>
              {lede ? (
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-cloud-400">{lede}</p>
              ) : null}

              <div className="mt-7">{children}</div>
            </div>

            <div className="mt-5 text-center text-[0.9375rem] text-cloud-300">{footer}</div>
          </div>
        </div>
      </Container>
    </main>
  );
}
