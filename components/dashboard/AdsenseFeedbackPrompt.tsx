"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock3, MessageSquareQuote, XCircle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { REJECTION_REASONS } from "@/lib/ml/constants";

/**
 * "Did AdSense approve your site?" — shown on the dashboard 14 days after
 * a scan, one site at a time. The answer is checked and recorded on the
 * server (/api/account/adsense-feedback); this card only collects it.
 */
export function AdsenseFeedbackPrompt({ requestId, domain, scannedOn }: { requestId: string; domain: string; scannedOn: string | null }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  async function answer(outcome: "approved" | "rejected" | "not_applied") {
    setBusy(outcome);
    try {
      const res = await fetch("/api/account/adsense-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, outcome, reason: outcome === "rejected" ? reason || null : null }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string } | null;
      if (data?.ok) {
        success("Answer saved", data.message ?? "Thank you.");
        router.refresh();
      } else {
        error("Not saved", data?.message ?? "Unexpected answer from the server.");
        if (res.status === 409 || res.status === 404) router.refresh();
      }
    } catch {
      error("Not saved", "Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="adsense-feedback" aria-labelledby="adsense-feedback-title" className="glass rounded-xl border-azure-500/20 bg-azure-500/[0.04] p-4 sm:p-5">
      <div className="flex gap-3">
        <MessageSquareQuote className="mt-0.5 size-5 shrink-0 text-azure-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="adsense-feedback-title" className="text-[1rem] font-semibold text-cloud-50">
            Did AdSense approve <span className="break-words">{domain}</span>?
          </h2>
          <p className="mt-1 text-[0.875rem] leading-relaxed text-cloud-400">
            {scannedOn ? `You scanned it on ${scannedOn}. ` : ""}Your answer — never your site&apos;s content — helps make readiness estimates more accurate.
          </p>

          {rejecting ? (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[0.8125rem] font-medium text-cloud-300">Reason Google gave (optional)</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="h-11 rounded-lg border border-ink-700 bg-white px-3 text-[0.9375rem] text-cloud-50 outline-none focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15"
                >
                  <option value="">Not sure / not stated</option>
                  {REJECTION_REASONS.filter((r) => r.id !== "other").map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                  <option value="other">Other</option>
                </select>
              </label>
              <div className="flex gap-2">
                <Button size="md" disabled={busy !== null} onClick={() => answer("rejected")}>
                  {busy === "rejected" ? <Spinner /> : null}
                  Save answer
                </Button>
                <Button size="md" variant="quiet" disabled={busy !== null} onClick={() => setRejecting(false)}>
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => answer("approved")}>
                {busy === "approved" ? <Spinner /> : <CheckCircle2 className="size-4 text-mint-400" aria-hidden />}
                Approved
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRejecting(true)}>
                <XCircle className="size-4 text-rose-400" aria-hidden />
                Rejected
              </Button>
              <Button size="sm" variant="quiet" disabled={busy !== null} onClick={() => answer("not_applied")}>
                {busy === "not_applied" ? <Spinner /> : <Clock3 className="size-4" aria-hidden />}
                Not applied yet
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
