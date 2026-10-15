"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { LogOut, Menu, X } from "lucide-react";

import { Avatar } from "@/components/account/Avatar";
import { AccountMenu, accountLinks, useLogout } from "@/components/sections/AccountMenu";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";
import { useViewer, type Viewer } from "@/lib/client-session";
import { cn } from "@/lib/cn";

const links = [
  { label: "Home", href: "/" },
  { label: "How it works", href: "/#process" },
  { label: "Pricing", href: "/pricing" },
  // These two used to point at #tools and #report, which do not exist.
  { label: "Tools", href: "/#features" },
  { label: "Team", href: "/team" },
  // The homepage shows approval results in #approval-results; the older
  // #approval-gallery section is no longer rendered there.
  { label: "Success Stories", href: "/#approval-results" },
];

/**
 * What the server already knows about the visitor.
 *
 * A dynamically rendered page (Pricing) passes the session it resolved, so
 * the right controls are in the first paint. A statically rendered page
 * (the homepage, Team) passes nothing; the bar then asks /api/auth/session
 * once and, until it hears back, shows neither "Log in" nor an account —
 * a signed-in visitor never sees a stale logged-out bar flash past.
 */
export type NavViewer = Viewer | null | undefined;

const primaryCta =
  "cursor-pointer whitespace-nowrap rounded-xl bg-azure-500 px-5 py-2.5 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-azure-600";
const quietLink =
  "cursor-pointer whitespace-nowrap rounded-xl px-3.5 py-2.5 text-[0.9375rem] font-medium text-cloud-50 transition-colors hover:bg-ink-800";

export function Navbar({ viewer: known }: { viewer?: NavViewer } = {}) {
  const viewer = useViewer(known);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const signOut = useLogout();

  useEffect(() => {
    let lastScrollY = window.scrollY;

    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      setScrolled(currentScrollY > 20);

      if (currentScrollY < 80 || currentScrollY < lastScrollY) {
        setVisible(true);
      } else if (currentScrollY > lastScrollY) {
        setVisible(false);
        setOpen(false);
      }
      lastScrollY = currentScrollY;
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const checkHref = viewer ? "/dashboard/checker" : "/#top";

  return (
    <motion.header
      initial={{ y: 0, opacity: 1 }}
      animate={{ y: visible ? 0 : -120, opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-x-0 top-0 z-50 px-3 sm:px-5"
    >
      <Container size="wide">
        <nav
          aria-label="Main"
          className={cn(
            "relative mx-auto flex items-center justify-between gap-4 transition-all duration-300",
            scrolled
              ? "mt-3 rounded-xl border border-ink-700 bg-white/95 px-4 py-2.5 shadow-[0_8px_30px_-12px_rgba(24,24,27,0.18)] backdrop-blur-xl sm:px-5"
              : "mt-4 px-2 py-3 sm:px-4",
          )}
        >
          {/* Logo */}
          <Link href="/" className="flex shrink-0 items-center" aria-label="Home">
            {/* Intrinsic size is the file's real 2078×757; the rendered size
                comes from the height class so the logo never crowds the bar. */}
            <Image
              src="/logo.png"
              alt="AdSense Checker"
              width={2078}
              height={757}
              sizes="(min-width: 1280px) 154px, 132px"
              className="h-11 w-auto sm:h-12 xl:h-14"
              priority
            />
          </Link>

          {/* Desktop navigation */}
          <div className="hidden min-w-0 items-center gap-0.5 xl:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="whitespace-nowrap rounded-lg px-3 py-2 text-[0.9375rem] font-medium text-cloud-200 transition-colors hover:bg-ink-800 hover:text-cloud-50"
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Desktop actions */}
          <div className="hidden shrink-0 items-center gap-2 xl:flex">
            {viewer === undefined ? (
              // Same footprint as the signed-out controls, so nothing jumps.
              <span aria-hidden className="block h-10 w-[15.5rem]" />
            ) : viewer ? (
              <>
                <Link href="/dashboard" className={quietLink}>
                  Dashboard
                </Link>
                <Link href={checkHref} className={primaryCta}>
                  Check My Site
                </Link>
                <AccountMenu viewer={viewer} />
              </>
            ) : (
              <>
                <Link href="/login" prefetch={false} className={quietLink}>
                  Log in
                </Link>
                <Link href={checkHref} className={primaryCta}>
                  Check My Site
                </Link>
              </>
            )}
          </div>

          {/* Mobile menu button */}
          <Button
            variant="ghost"
            size="sm"
            className="xl:hidden"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
          >
            {viewer ? <Avatar name={viewer.name} src={viewer.avatarUrl} size="xs" className="-ml-1.5" /> : null}
            {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </Button>
        </nav>

        {/* Mobile navigation */}
        <AnimatePresence>
          {open && (
            <motion.div
              id="mobile-nav"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="mt-2 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-xl border border-ink-700 bg-white p-2.5 shadow-[0_16px_40px_-16px_rgba(24,24,27,0.25)] xl:hidden"
            >
              <div className="flex flex-col">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3.5 py-3 text-[1rem] font-medium text-cloud-50 transition-colors hover:bg-ink-800"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>

              <div className="mt-2 border-t border-ink-700 pt-2.5">
                {viewer === undefined ? (
                  <span aria-hidden className="block h-24" />
                ) : viewer ? (
                  <SignedInMobile
                    viewer={viewer}
                    checkHref={checkHref}
                    close={() => setOpen(false)}
                    signOut={signOut}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    <Link
                      href="/login"
                      prefetch={false}
                      onClick={() => setOpen(false)}
                      className="rounded-lg px-3.5 py-3 text-[1rem] font-medium text-cloud-50 transition-colors hover:bg-ink-800"
                    >
                      Log in
                    </Link>
                    <Link
                      href={checkHref}
                      onClick={() => setOpen(false)}
                      className="rounded-xl bg-azure-500 px-4 py-3 text-center text-[1rem] font-semibold text-white transition-colors hover:bg-azure-600"
                    >
                      Check My Site
                    </Link>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Container>
    </motion.header>
  );
}

function SignedInMobile({
  viewer,
  checkHref,
  close,
  signOut,
}: {
  viewer: Viewer;
  checkHref: string;
  close: () => void;
  signOut: ReturnType<typeof useLogout>;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <Avatar name={viewer.name} src={viewer.avatarUrl} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-[0.9375rem] font-semibold text-cloud-50">{viewer.name}</p>
          <p className="truncate text-[0.8125rem] text-cloud-400">{viewer.email}</p>
        </div>
      </div>

      {accountLinks(viewer).map((link) => (
        <Link
          key={link.href}
          href={link.href}
          onClick={close}
          className="flex items-center gap-3 rounded-lg px-3.5 py-3 text-[1rem] font-medium text-cloud-50 transition-colors hover:bg-ink-800"
        >
          <link.icon className="size-[1.1rem] text-cloud-400" aria-hidden />
          {link.label}
        </Link>
      ))}

      <button
        type="button"
        onClick={async () => {
          await signOut.run();
          close();
        }}
        disabled={signOut.busy}
        className="flex items-center gap-3 rounded-lg px-3.5 py-3 text-left text-[1rem] font-medium text-cloud-50 transition-colors hover:bg-rose-400/[0.06] hover:text-rose-400 disabled:opacity-60"
      >
        <LogOut className="size-[1.1rem] text-cloud-400" aria-hidden />
        {signOut.busy ? "Logging out…" : "Log out"}
      </button>
      {signOut.failed ? (
        <p role="alert" className="px-3.5 pb-2 text-[0.8125rem] text-rose-400">
          Could not log out. Check your connection and try again.
        </p>
      ) : null}

      <Link
        href={checkHref}
        onClick={close}
        className="mt-2 rounded-xl bg-azure-500 px-4 py-3 text-center text-[1rem] font-semibold text-white transition-colors hover:bg-azure-600"
      >
        Check My Site
      </Link>
    </div>
  );
}
