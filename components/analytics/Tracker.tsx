"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import {
  consentChoice,
  currentConsentMode,
  onConsentMode,
  optedOut,
  setConsent,
  trackEvent,
} from "./track";

const PLAN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Mounted once in the root layout. Sends a page view on every route
 * change, a pricing view on /pricing, and a plan selection when a link to
 * checkout or sign-up for a plan is clicked. Renders nothing unless the
 * site is in "ask" mode and this visitor hasn't chosen yet.
 */
export function Tracker() {
  const pathname = usePathname();
  const [banner, setBanner] = useState<"ask" | "info" | null>(null);

  useEffect(() => {
    if (!pathname || pathname.startsWith("/admin")) return;
    // After paint, so it never competes with the page itself.
    const id = window.setTimeout(() => {
      trackEvent("page_view");
      // The server records the site currency with it.
      if (pathname === "/pricing") trackEvent("pricing_viewed");
    }, 0);
    return () => window.clearTimeout(id);
  }, [pathname]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname !== "/checkout" && url.pathname !== "/signup") return;
      const plan = url.searchParams.get("plan");
      if (!plan || !PLAN.test(plan)) return;
      trackEvent("plan_selected", { plan });
    }
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  useEffect(() => {
    const off = onConsentMode((mode) => {
      if (mode === "ask" && consentChoice() === null && !optedOut()) setBanner("ask");
      if (mode === "none") setBanner((b) => (b === "ask" ? null : b));
    });
    function reopen() {
      if (currentConsentMode() === "ask") {
        setConsent(null);
        setBanner("ask");
      } else {
        setBanner("info");
      }
    }
    window.addEventListener("aec:analytics-choices", reopen);
    return () => {
      off();
      window.removeEventListener("aec:analytics-choices", reopen);
    };
  }, []);

  if (!banner || pathname?.startsWith("/admin")) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Analytics choices"
      className="no-print fixed bottom-4 left-4 z-[60] w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-ink-700 bg-white p-4 text-[0.875rem] leading-relaxed text-cloud-200 shadow-[0_8px_30px_rgba(24,24,27,0.12)]"
    >
      {banner === "ask" ? (
        <>
          <p className="font-semibold text-cloud-50">Remember this browser for visit statistics?</p>
          <p className="mt-1">
            We count visits with our own analytics. If you allow it, we store a random ID on this device so a return visit
            isn&apos;t counted as a new visitor. No name, email or advertising — and nothing is shared.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setConsent("granted");
                setBanner(null);
              }}
              className="inline-flex h-9 items-center rounded-lg bg-azure-500 px-3.5 font-medium text-white transition-colors hover:bg-azure-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={() => {
                setConsent("denied");
                setBanner(null);
              }}
              className="inline-flex h-9 items-center rounded-lg border border-ink-700 px-3.5 font-medium text-cloud-100 transition-colors hover:bg-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
            >
              No thanks
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="font-semibold text-cloud-50">Cookie-free analytics</p>
          <p className="mt-1">
            This site counts visits with its own analytics and stores nothing on your device for it. Your browser&apos;s
            Do Not Track or Global Privacy Control setting turns it off completely.
          </p>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="mt-3 inline-flex h-9 items-center rounded-lg border border-ink-700 px-3.5 font-medium text-cloud-100 transition-colors hover:bg-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
          >
            Close
          </button>
        </>
      )}
    </div>
  );
}

/** Footer link that reopens the choice. */
export function AnalyticsChoicesButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event("aec:analytics-choices"))}>
      Analytics choices
    </button>
  );
}
