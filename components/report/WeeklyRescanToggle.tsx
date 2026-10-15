"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";

import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

/**
 * Weekly rescans for this site (feature 53). The switch only asks; the
 * server checks the plan and the site again and answers with the real
 * state, which is what the page then shows.
 */
export function WeeklyRescanToggle({
  domain,
  enabled,
  note,
}: {
  domain: string;
  enabled: boolean;
  /** "Next scan around …", or why it is paused. */
  note: string | null;
}) {
  const router = useRouter();
  const { success, error } = useToast();
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !on;
    setBusy(true);
    try {
      const res = await fetch("/api/account/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, enabled: next }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string; enabled?: boolean } | null;
      if (!data?.ok) {
        error("Not changed", data?.message ?? "Unexpected answer from the server.");
        return;
      }
      setOn(Boolean(data.enabled));
      success(data.enabled ? "Weekly rescans on" : "Weekly rescans off", data.enabled ? `We'll rescan ${domain} every week and email you when findings change.` : `${domain} won't be rescanned automatically.`);
      router.refresh();
    } catch {
      error("Not changed", "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-[0.875rem]">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Weekly rescans"
        disabled={busy}
        onClick={toggle}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-60",
          on ? "border-azure-500 bg-azure-500" : "border-ink-700 bg-ink-850",
        )}
      >
        <span className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", on ? "translate-x-6" : "translate-x-1")} />
      </button>
      <span className="inline-flex items-center gap-1.5 font-medium text-cloud-200">
        {busy ? <Spinner /> : <CalendarClock className="size-4 text-cloud-400" aria-hidden />}
        Weekly rescans
      </span>
      {note ? <span className="text-cloud-400">{note}</span> : null}
    </div>
  );
}
