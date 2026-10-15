"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

/** The site-wide "Enable yearly billing" switch. The server checks the admin again. */
export function YearlyBillingSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant={enabled ? "ghost" : "primary"}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch("/api/admin/pricing/yearly", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !enabled }),
          });
          const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string } | null;
          if (!data?.ok) error("Not changed", data?.message ?? "Unexpected answer from the server.");
          else success(enabled ? "Yearly billing off" : "Yearly billing on", enabled ? "Customers now see monthly prices only." : "Plans with a yearly price now show it on the pricing page.");
          router.refresh();
        } catch {
          error("Not changed", "Couldn't reach the server.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner /> : null}
      {enabled ? "Turn yearly billing off" : "Enable yearly billing"}
    </Button>
  );
}
