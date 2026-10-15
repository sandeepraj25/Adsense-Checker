"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

async function post(url: string) {
  try {
    const res = await fetch(url, { method: "POST" });
    return ((await res.json().catch(() => null)) ?? { ok: false, message: "Unexpected answer from the server." }) as {
      ok: boolean;
      message?: string;
      outcome?: string;
      version?: string | null;
    };
  } catch {
    return { ok: false, message: "Couldn't reach the server." };
  }
}

/** "Retrain now": the same run as the nightly job, with its outcome shown here. */
export function RetrainButton({ running }: { running: boolean }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button
        size="sm"
        disabled={busy || running}
        onClick={async () => {
          setBusy(true);
          setNotice(null);
          const result = await post("/api/admin/ml/train");
          setBusy(false);
          if (!result.ok) {
            setNotice({ tone: "error", text: result.message ?? "Training could not start." });
            error("Not trained", result.message ?? "");
          } else {
            const tone = result.outcome === "promoted" ? "ok" : result.outcome === "failed" ? "error" : "warn";
            setNotice({ tone, text: result.message ?? "" });
            if (result.outcome === "promoted") success("New model active", result.version ?? "");
            else if (result.outcome === "failed") error("Training failed", "See the training history below.");
          }
          router.refresh();
        }}
      >
        {busy || running ? <Spinner /> : <RefreshCw className="size-3.5" aria-hidden />}
        {busy ? "Training…" : running ? "Training in progress" : "Retrain now"}
      </Button>
      {notice ? (
        <p
          role="status"
          className={`max-w-sm text-[0.8125rem] leading-snug ${notice.tone === "ok" ? "text-mint-400" : notice.tone === "warn" ? "text-amber-400" : "text-rose-400"}`}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

/** Restores a version that was active before. */
export function RollbackButton({ id, version }: { id: string; version: string }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        <RotateCcw className="size-3.5" aria-hidden />
        Restore
      </Button>
    );
  }
  return (
    <div className="flex gap-1.5">
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const result = await post(`/api/admin/ml/versions/${encodeURIComponent(id)}/activate`);
          setBusy(false);
          setConfirming(false);
          if (result.ok) success("Model restored", `${version} is active again.`);
          else error("Not restored", result.message ?? "");
          router.refresh();
        }}
      >
        {busy ? <Spinner /> : null}
        Make {version} active
      </Button>
      <Button size="sm" variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
  );
}
