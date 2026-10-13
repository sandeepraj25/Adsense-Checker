import Link from "next/link";

import { Container } from "@/components/ui/Container";
import { Logomark, Wordmark } from "@/components/illustrations/Logomark";
import type { User } from "@/lib/db/types";

/**
 * Header for the pages outside the homepage. The homepage keeps its own
 * <Navbar> — that one hides on scroll and navigates by hash, neither of
 * which makes sense on a standalone page. This is the same pill-nav
 * treatment in its settled state, with real routes.
 */
const links = [
  { label: "Home", href: "/" },
  { label: "How it works", href: "/#process" },
  { label: "Pricing", href: "/pricing" },
];

export function SiteHeader({ user }: { user?: User | null }) {
  return (
    <header className="glass-deep sticky top-0 z-50 border-b border-ink-700">
      <Container size="wide">
        <nav className="flex items-center justify-between py-3.5">
          <Link
            href="/"
            className="group flex shrink-0 items-center gap-3"
            aria-label="Verdict home"
          >
            <span className="transition-transform duration-300 group-hover:scale-105">
              <Logomark size={30} />
            </span>
            <Wordmark />
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-full px-3.5 py-2 text-[0.9375rem] font-medium text-cloud-200 transition-colors duration-300 hover:bg-ink-800 hover:text-cloud-50"
              >
                {link.label}
              </Link>
            ))}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {user ? (
              <Link
                href="/dashboard"
                className="rounded-xl bg-azure-500 px-4 py-2.5 text-[0.9375rem] font-semibold text-white transition-all duration-300 hover:bg-azure-400"
              >
                Dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-xl px-3.5 py-2.5 text-[0.9375rem] font-medium text-cloud-200 transition-colors duration-300 hover:bg-ink-800 hover:text-cloud-50"
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-xl bg-azure-500 px-4 py-2.5 text-[0.9375rem] font-semibold text-white transition-all duration-300 hover:bg-azure-400"
                >
                  Get started
                </Link>
              </>
            )}
          </div>
        </nav>
      </Container>
    </header>
  );
}
