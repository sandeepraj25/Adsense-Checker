"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  CreditCard,
  ExternalLink,
  Gauge,
  Layers,
  LogOut,
  Menu,
  Receipt,
  ScrollText,
  ShieldCheck,
  UserRound,
  Users,
  X,
  Tags,
  MessagesSquare,
  Headset,
  BellRing,
  ChartNoAxesCombined,
  Coins,
} from "lucide-react";

import { Avatar } from "@/components/account/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { logout } from "@/lib/client-session";
import { cn } from "@/lib/cn";

const NAV = [
  { label: "Overview", href: "/admin", icon: Gauge },
  { label: "Website analytics", href: "/admin/analytics", icon: ChartNoAxesCombined },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Plans", href: "/admin/plans", icon: Layers },
  { label: "Pricing", href: "/admin/pricing", icon: Tags },
  { label: "Website currency", href: "/admin/settings/currency", icon: Coins },
  { label: "Live chat", href: "/admin/chats", icon: MessagesSquare },
  { label: "Support team", href: "/admin/support-team", icon: Headset },
  { label: "Notifications", href: "/admin/settings/notifications", icon: BellRing },
  {
    label: "Subscriptions",
    href: "/admin/subscriptions",
    icon: Receipt,
  },
  {
    label: "Payment gateways",
    href: "/admin/payment-gateways",
    icon: CreditCard,
  },
  {
    label: "Audit log",
    href: "/admin/logs",
    icon: ScrollText,
  },
  { label: "My account", href: "/admin/account", icon: UserRound },
];

export function AdminShell({
  admin,
  chatUnread = 0,
  children,
}: {
  admin: { name: string; email: string; avatarUrl?: string | null };
  /** Unread customer messages, for the Live chat badge. */
  chatUnread?: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="relative min-h-screen bg-ink-950">
      <div
        aria-hidden
        className="app-glow no-print pointer-events-none fixed inset-x-0 top-0 h-[60vh]"
      />

      {/* ── Mobile header ─────────────────────────────────────── */}
      <header className="glass-deep no-print sticky top-0 z-40 flex items-center justify-between border-b border-ink-700 px-4 py-3 lg:hidden">
        <Link href="/admin" className="flex items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
            <Image
              src="/logo.png"
              alt="AdSense Checker"
              width={28}
              height={28}
              priority
              className="size-7 object-contain"
            />
          </div>

          <div>
            <p className="text-[0.9375rem] font-semibold text-cloud-50">
              Admin panel
            </p>

            <div className="mt-1 flex items-center gap-1.5">
              <ShieldCheck
                className="size-3 text-amber-400"
                aria-hidden
              />
              <span className="text-[0.75rem] font-medium text-cloud-300">
                Administrator
              </span>
            </div>
          </div>
        </Link>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="admin-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          className="glass rounded-xl p-2.5 text-cloud-50 transition-colors hover:bg-ink-800"
        >
          {open ? (
            <X className="size-5" />
          ) : (
            <Menu className="size-5" />
          )}
        </button>
      </header>

      {/* ── Desktop sidebar ───────────────────────────────────── */}
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-[17.75rem] flex-col border-r border-ink-700 bg-ink-950 lg:flex">
        {/* Top user panel */}
        <div className="border-b border-ink-700 p-4">
          <Link
            href="/admin"
            className="flex items-center gap-3 rounded-xl px-1 py-1 transition-colors hover:bg-ink-800"
          >
            {/* Photo (or initials) identifies whose panel this is */}
            <Avatar name={admin.name} src={admin.avatarUrl} size="md" />

            {/* Admin info */}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-[0.9375rem] font-semibold text-cloud-50">
                  {admin.name}
                </p>

                <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-400/[0.10] px-1.5 py-0.5 text-[0.75rem] font-semibold tracking-[0.1em] text-amber-300">
                  <ShieldCheck
                    className="size-2.5"
                    aria-hidden
                  />
                  Admin
                </span>
              </div>

              <p className="mt-1 truncate text-[0.75rem] text-cloud-400">
                {admin.email}
              </p>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <div className="flex-1 px-3 py-5">
          <p className="mb-2 px-3.5 text-[0.75rem] font-semibold tracking-[0.16em] text-cloud-400">
            Administration
          </p>

          <NavList pathname={pathname} chatUnread={chatUnread} />
        </div>

        {/* Bottom area */}
        <div className="border-t border-ink-700 p-4">
          <Link
            href="/dashboard"
            className="glass flex items-center justify-between gap-2 rounded-xl px-3.5 py-3 text-[0.875rem] text-cloud-50 transition-all duration-200 hover:border-ink-700 hover:bg-ink-800"
          >
            <span>Customer dashboard</span>

            <ExternalLink
              className="size-3.5 shrink-0 text-cloud-400"
              aria-hidden
            />
          </Link>

          <div className="mt-3 flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 p-2.5">
            <Link
              href="/admin/account"
              title="My account"
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <Avatar name={admin.name} src={admin.avatarUrl} size="sm" />

              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] font-semibold text-cloud-50">
                  {admin.name}
                </p>

                <p className="mt-0.5 truncate text-[0.75rem] text-cloud-400">
                  {admin.email}
                </p>
              </div>
            </Link>

            <LogoutButton />
          </div>
        </div>
      </aside>

      {/* ── Mobile drawer ─────────────────────────────────────── */}
      <AnimatePresence>
        {open ? (
          <motion.div
            id="admin-nav"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{
              duration: 0.24,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="fixed inset-x-0 top-[4.5rem] z-40 border-b border-ink-700 bg-ink-950 px-4 pt-4 pb-5 shadow-lg lg:hidden"
          >
            {/* Mobile admin info */}
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 p-3">
              <Avatar name={admin.name} src={admin.avatarUrl} size="md" />

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[0.875rem] font-semibold text-cloud-50">
                    {admin.name}
                  </p>

                  <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-amber-300">
                    <ShieldCheck
                      className="size-3"
                      aria-hidden
                    />
                    Admin
                  </span>
                </div>

                <p className="mt-1 truncate text-[0.75rem] text-cloud-400">
                  {admin.email}
                </p>
              </div>
            </div>

            <NavList pathname={pathname} chatUnread={chatUnread} />

            <Link
              href="/dashboard"
              className="mt-4 flex items-center justify-between gap-2 rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-3 text-[0.875rem] text-cloud-50"
            >
              Customer dashboard

              <ExternalLink
                className="size-3.5 shrink-0 text-cloud-400"
                aria-hidden
              />
            </Link>

            <LogoutButton wide />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Content ───────────────────────────────────────────── */}
      <div className="dash-content relative lg:pl-[17.75rem]">
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavList({ pathname, chatUnread }: { pathname: string; chatUnread: number }) {
  return (
    <nav aria-label="Admin">
      <ul className="space-y-1">
        {NAV.map((item) => {
          const active =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(item.href);

          const Icon = item.icon;

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                data-active={active}
                className={cn(
                  "relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[0.9375rem] transition-all duration-300",
                  active
                    ? "bg-azure-500/[0.08] font-semibold text-azure-600"
                    : "text-cloud-300 hover:bg-ink-800 hover:text-cloud-50",
                )}
              >
                {active ? (
                  <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-azure-500" />
                ) : null}

                <Icon
                  className={cn(
                    "size-[1.05rem] shrink-0",
                    active ? "text-azure-600" : "text-cloud-400",
                  )}
                  aria-hidden
                />

                <span>{item.label}</span>
                {item.href === "/admin/chats" && chatUnread > 0 ? (
                  <span className="ml-auto grid min-w-5 place-items-center rounded-full bg-azure-500 px-1.5 text-[0.6875rem] font-semibold leading-5 text-white">
                    {chatUnread > 99 ? "99+" : chatUnread}
                    <span className="sr-only"> unread chat messages</span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
function LogoutButton({ wide = false }: { wide?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    if (await logout()) {
      router.replace("/");
      router.refresh();
      return;
    }
    setFailed(true);
    setBusy(false);
  }

  if (wide) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-ink-700 bg-white px-3.5 py-3 text-[0.875rem] text-cloud-50 transition-colors hover:border-rose-400/30 hover:text-rose-400 disabled:opacity-60"
        >
          {busy ? "Logging out…" : "Log out"}
          {busy ? <Spinner className="size-4" /> : <LogOut className="size-4" aria-hidden />}
        </button>
        {failed ? (
          <p role="alert" className="mt-1.5 text-[0.75rem] text-rose-400">
            Could not log out. Try again.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      aria-label={failed ? "Log out failed — try again" : "Log out"}
      title={failed ? "Log out failed — try again" : "Log out"}
      className={cn(
        "shrink-0 rounded-lg p-2 transition-colors hover:bg-rose-400/[0.08] hover:text-rose-400 disabled:opacity-55",
        failed ? "text-rose-400" : "text-cloud-400",
      )}
    >
      {busy ? <Spinner className="size-4" /> : <LogOut className="size-4" aria-hidden />}
    </button>
  );
}
