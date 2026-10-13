"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { Avatar } from "@/components/account/Avatar";
import { logout, type Viewer } from "@/lib/client-session";
import { cn } from "@/lib/cn";

/**
 * The signed-in account menu on public pages. Admin entries appear only
 * when the session says the viewer is an admin — and that is a display
 * hint: /admin re-checks the role on the server before rendering anything.
 */
export function accountLinks(viewer: Viewer) {
  const links = [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { label: "Billing", href: "/dashboard/billing", icon: CreditCard },
    { label: "Settings", href: "/dashboard/settings", icon: Settings },
  ];
  if (viewer.isAdmin) {
    links.push(
      { label: "Admin panel", href: "/admin", icon: ShieldCheck },
      { label: "Admin account", href: "/admin/account", icon: UserRound },
    );
  }
  return links;
}

export function useLogout() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await logout();
    setBusy(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    // Re-render the current page for a signed-out visitor; no full reload.
    router.refresh();
  }

  return { run, busy, failed };
}

export function AccountMenu({ viewer }: { viewer: Viewer }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { run, busy, failed } = useLogout();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${viewer.name}`}
        className="flex items-center gap-1.5 rounded-full border border-ink-700 bg-white p-0.5 pr-2 transition-colors hover:border-zinc-300"
      >
        <Avatar name={viewer.name} src={viewer.avatarUrl} size="xs" />
        <ChevronDown
          className={cn("size-3.5 text-cloud-400 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-ink-700 bg-white shadow-[0_12px_32px_-12px_rgba(24,24,27,0.25)]"
        >
          <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-3">
            <Avatar name={viewer.name} src={viewer.avatarUrl} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-[0.875rem] font-semibold text-cloud-50">{viewer.name}</p>
              <p className="truncate text-[0.75rem] text-cloud-400">{viewer.email}</p>
            </div>
          </div>

          <div className="p-1.5">
            {accountLinks(viewer).map((link) => (
              <Link
                key={link.href}
                href={link.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[0.875rem] text-cloud-200 transition-colors hover:bg-ink-900 hover:text-cloud-50"
              >
                <link.icon className="size-4 text-cloud-400" aria-hidden />
                {link.label}
              </Link>
            ))}
          </div>

          <div className="border-t border-ink-700 p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => void run()}
              disabled={busy}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.875rem] text-cloud-200 transition-colors hover:bg-rose-400/[0.06] hover:text-rose-400 disabled:opacity-60"
            >
              <LogOut className="size-4" aria-hidden />
              {busy ? "Logging out…" : "Log out"}
            </button>
            {failed ? (
              <p role="alert" className="px-2.5 pb-1.5 text-[0.75rem] text-rose-400">
                Could not log out. Check your connection and try again.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
