"use client";

import { useEffect } from "react";

/**
 * Opens a guide when the page is reached with its anchor (/#guide-ads-txt),
 * so links from elsewhere land on the guide expanded rather than closed.
 */
export function OpenFromHash({ ids }: { ids: string[] }) {
  useEffect(() => {
    function open() {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!ids.includes(id)) return;
      const el = document.getElementById(id);
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView({ block: "start" });
      }
    }
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [ids]);
  return null;
}
