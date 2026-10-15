"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

/**
 * "Switch to yearly at renewal" — saves the choice on the server; nothing
 * is charged now and the current period is unchanged.
 */
export function RenewalCycleControl({
  current,
  scheduled,
  target,
  renewsOn,
  offerNote,
}: {
  current: "monthly" | "yearly";
  scheduled: "monthly" | "yearly" | null;
  /** The cycle this control offers to move to. */
  target: "monthly" | "yearly";
  renewsOn: string;
  /** "₹3,990/year · save 17%", shown with the offer. */
  offerNote: string | null;
}) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState(false);

  async function save(cycle: "monthly" | "yearly" | null) {
    setBusy(true);
    try {
      const res = await fetch("/api/account/billing-cycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string; nextBillingCycle?: string | null } | null;
      if (!data?.ok) {
        error("Not changed", data?.message ?? "Unexpected answer from the server.");
        return;
      }
      success(
        data.nextBillingCycle ? "Change scheduled" : "Scheduled change removed",
        data.nextBillingCycle ? `Your renewal on ${renewsOn} will default to ${data.nextBillingCycle} billing. Nothing is charged now.` : `You'll renew ${current} as before.`,
      );
      router.refresh();
    } catch {
      error("Not changed", "Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 flex flex-col gap-3 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3 text-[0.875rem] leading-relaxed">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-cloud-400" aria-hidden />
        {scheduled ? (
          <p className="text-cloud-200">
            <span className="font-medium text-cloud-50">Switching to {scheduled} billing at renewal</span> on {renewsOn}. Your current {current} period is unchanged and nothing is charged now.
          </p>
        ) : (
          <p className="text-cloud-200">
            <span className="font-medium text-cloud-50">Pay {target} from your next renewal</span>
            {offerNote ? ` — ${offerNote}` : ""}. Applies on {renewsOn}; nothing is charged now.
          </p>
        )}
      </div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(scheduled ? null : target)} className="shrink-0">
        {busy ? <Spinner /> : null}
        {scheduled ? "Keep current billing" : `Switch to ${target} at renewal`}
      </Button>
    </div>
  );
}
