"use client";

/** Opens the floating support chat (components/chat/ChatWidget listens). */
function openSupportChat() {
  window.dispatchEvent(new CustomEvent("aec:open-chat"));
}

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  CreditCard,
  Crown,
  FileText,
  Headphones,
  LayoutDashboard,
  LogOut,
  Menu,
  Radar,
  Settings,
  X,
} from "lucide-react";

import { Avatar } from "@/components/account/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { logout as endSession } from "@/lib/client-session";
import { cn } from "@/lib/cn";

const NAV = [
  {
    label: "Overview",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    label: "New Scan",
    href: "/dashboard/checker",
    icon: Radar,
  },
  {
    label: "Reports",
    href: "/dashboard/reports",
    icon: FileText,
  },
  {
    label: "Billing",
    href: "/dashboard/billing",
    icon: CreditCard,
  },
  {
    label: "Settings",
    href: "/dashboard/settings",
    icon: Settings,
  },
];

export type ShellPlan = {
  planName: string;
  scansUsed: number;
  scanLimit: number;
  isUsable: boolean;
} | null;

export type ShellUser = {
  name: string;
  email: string;
  avatarUrl?: string | null;
};

export function DashboardShell({
  user,
  plan,
  children,
}: {
  user: ShellUser;
  plan: ShellPlan;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close mobile sidebar when route changes
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prevent page scrolling when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="min-h-screen bg-ink-900 text-cloud-50">

      {/* ================= MOBILE HEADER ================= */}
      <header className="glass-deep no-print sticky top-0 z-50 flex items-center justify-between border-b border-ink-700 px-4 py-3 lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-3">
          <Image
            src="/logo.png"
            alt="Logo"
            width={42}
            height={42}
            className="h-9 w-auto object-contain"
          />

          <span className="text-base font-semibold text-cloud-50">
            Dashboard
          </span>
        </Link>

        <div className="flex items-center gap-2">
        <Avatar name={user.name} src={user.avatarUrl} size="sm" />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="dash-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          className="glass rounded-xl p-2.5 text-cloud-50 transition-colors hover:bg-ink-800"
        >
          {open ? (
            <X className="size-5" />
          ) : (
            <Menu className="size-5" />
          )}
        </button>
        </div>
      </header>

      {/* ================= DESKTOP SIDEBAR ================= */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-[16.5rem] text-cloud-50 lg:block">
        <div className="flex h-full flex-col border-r border-ink-700 bg-white">

          {/* ================= LOGO ================= */}
          <div className="flex h-16 items-center border-b border-ink-700 px-5">
            <Link href="/" className="flex items-center" aria-label="Home">
              <Image
                src="/logo.png"
                alt="AdSense Checker"
                width={2078}
                height={757}
                sizes="110px"
                className="h-10 w-auto"
              />
            </Link>
          </div>

          {/* ================= NAVIGATION ================= */}
          <div className="flex-1 overflow-y-auto px-3 py-4">
            <NavList pathname={pathname} />
          </div>

          {/* ================= BOTTOM ================= */}
          <div className="border-t border-ink-700 p-3">
            <PlanChip plan={plan} />

            <button
              type="button"
              onClick={openSupportChat}
              className="mb-2 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-cloud-300 transition-colors hover:bg-ink-800 hover:text-cloud-50"
            >
              <Headphones className="size-4 text-cloud-400" aria-hidden />
              Support chat
            </button>

            <AccountRow user={user} />
          </div>
        </div>
      </aside>

      {/* ================= MOBILE DRAWER ================= */}
      <AnimatePresence>
        {open ? (
          <>
            {/* Overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-ink-900 backdrop-blur-sm lg:hidden"
              onClick={() => setOpen(false)}
            />

            {/* Drawer */}
            <motion.aside
              id="dash-nav"
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{
                duration: 0.25,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="glass-deep fixed inset-y-0 left-0 z-50 flex w-[19rem] flex-col border-r border-ink-700 text-cloud-50 lg:hidden"
            >
              {/* Mobile top */}
              <div className="flex items-center justify-between border-b border-ink-700 p-5">
                <Link
                  href="/dashboard"
                  className="flex items-center gap-3"
                >
                  <Image
                    src="/logo.png"
                    alt="Website logo"
                    width={42}
                    height={42}
                    className="h-10 w-auto object-contain"
                  />

                  <span className="font-semibold text-cloud-50">
                    Dashboard
                  </span>
                </Link>

                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                  className="rounded-xl p-2 text-cloud-50 transition-colors hover:bg-ink-800"
                >
                  <X className="size-5" />
                </button>
              </div>

              {/* Mobile navigation */}
              <div className="flex-1 overflow-y-auto px-4 py-5">
                <NavList pathname={pathname} />
              </div>

              {/* Mobile bottom */}
              <div className="border-t border-ink-700 p-4">
                <PlanChip plan={plan} />

                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    openSupportChat();
                  }}
                  className="mb-3 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-cloud-50 transition-colors hover:bg-ink-800"
                >
                  <Headphones className="size-[1.05rem] text-cloud-50" aria-hidden />
                  Support chat
                </button>

                <AccountRow user={user} />
              </div>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      {/* ================= MAIN CONTENT ================= */}
      <div className="relative min-h-screen lg:pl-[16.5rem]">
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}

/* =========================================================
   NAVIGATION
========================================================= */

function NavList({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Dashboard">
      <ul className="space-y-0.5">
        {NAV.map((item) => {
          const active =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          const Icon = item.icon;

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[0.9375rem] transition-colors",
                  active
                    ? "bg-azure-500/[0.08] font-semibold text-azure-600"
                    : "font-medium text-cloud-300 hover:bg-ink-800 hover:text-cloud-50",
                )}
              >
                {active ? (
                  <span aria-hidden className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-azure-500" />
                ) : null}
                <Icon
                  className={cn(
                    "size-[1.05rem] shrink-0",
                    active ? "text-azure-600" : "text-cloud-400",
                  )}
                  aria-hidden
                />

                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* =========================================================
   PLAN CARD
========================================================= */

function PlanChip({ plan }: { plan: ShellPlan }) {
  if (!plan) {
    return (
      <Link
        href="/pricing"
        className="glass mb-4 block rounded-xl border border-ink-700 p-4 text-cloud-50 transition-colors hover:bg-ink-800"
      >
        <p className="text-xs font-semibold text-cloud-300">
          No active plan
        </p>

        <p className="mt-2 text-sm text-cloud-50">
          Choose a plan to run scans
        </p>
      </Link>
    );
  }

  return (
    <Link
      href="/dashboard/billing"
      className="glass edge-light mb-4 block rounded-xl border border-ink-700 p-4 text-cloud-50 transition-all duration-300 hover:border-azure-500/30 hover:bg-ink-800"
    >
      <div className="flex items-center gap-2">
        <Crown
          className="size-3.5 text-amber-400"
          strokeWidth={2.4}
        />
  
        <p className="text-xs font-semibold text-cloud-300">
          {plan.planName} plan
        </p>
      </div>
  
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-sm text-cloud-50">
          <span
            className={cn(
              "font-semibold",
              plan.isUsable ? "text-cloud-50" : "text-amber-400",
            )}
          >
            {plan.scansUsed} / {plan.scanLimit}
          </span>{" "}
          scans this month
        </p>
  
        <span className="text-xs font-medium text-cloud-400">
          {Math.round(
            (plan.scansUsed / plan.scanLimit) * 100,
          )}
          %
        </span>
      </div>
  
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink-900">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-400 to-indigo-400 transition-all duration-500"
          style={{
            width: `${Math.min(
              100,
              (plan.scansUsed / plan.scanLimit) * 100,
            )}%`,
          }}
        />
      </div>
    </Link>
  );
}

/* =========================================================
   ACCOUNT ROW
========================================================= */

function AccountRow({ user }: { user: ShellUser }) {
  const router = useRouter();
  const { error } = useToast();

  const [busy, setBusy] = useState(false);

  async function logout() {
    if (busy) return;

    setBusy(true);

    // Revokes the server session and tells every navbar at once.
    const ok = await endSession();
    if (ok) {
      router.replace("/");
      router.refresh();
      return;
    }

    error("Could not log out", "Check your connection and try again.");
    setBusy(false);
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 p-2.5">
      <Link
        href="/dashboard/settings"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg"
        title="Profile settings"
      >
        <Avatar name={user.name} src={user.avatarUrl} size="sm" />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-cloud-50">
            {user.name}
          </p>

          <p className="truncate text-xs text-cloud-400">
            {user.email}
          </p>
        </div>
      </Link>

      <button
        type="button"
        onClick={logout}
        disabled={busy}
        aria-label="Log out"
        title="Log out"
        className="shrink-0 rounded-lg p-2 text-cloud-400 transition-colors hover:bg-rose-400/[0.08] hover:text-rose-400 disabled:opacity-55"
      >
        {busy ? <Spinner className="size-4" /> : <LogOut className="size-4" />}
      </button>
    </div>
  );
}
