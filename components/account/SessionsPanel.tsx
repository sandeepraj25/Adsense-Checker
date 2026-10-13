"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, MonitorSmartphone } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { plural } from "@/lib/format";

/**
 * Sessions are opaque by design — we store a hash of the token, not the
 * token, so there is nothing to display per device beyond the count. The
 * useful action is therefore "revoke everything but this one".
 */
export function SessionsPanel({ count }: { count: number }) {
  const router = useRouter();
  const { success, error: errorToast } = useToast();
  const [busy, setBusy] = useState(false);

  const others = Math.max(0, count - 1);

  async function revoke() {
    if (busy) return;
    setBusy(true);

    try {
      const response = await fetch("/api/account/sessions", { method: "POST" });
      if (!response.ok) {
        errorToast("Could not sign out the other devices. Try again.");
        setBusy(false);
        return;
      }

      success(
        "Other devices signed out",
        `${plural(others, "session")} ended. This one is still active.`,
      );
      setBusy(false);
      router.refresh();
    } catch {
      errorToast("Network error", "Nothing was changed.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <MonitorSmartphone
          className="mt-0.5 size-4 shrink-0 text-azure-600"
          aria-hidden
        />
        <div>
          <p className="text-[0.9375rem] text-cloud-50">
            {count === 1
              ? "This is your only active session."
              : `${plural(count, "active session")}, including this one.`}
          </p>
          <p className="mt-1 max-w-lg text-[0.875rem] leading-relaxed text-cloud-600">
            Sessions last 30 days and renew as you use the app. Signing out
            elsewhere is the fastest fix if you left yourself logged in on a
            machine you do not control.
          </p>
        </div>
      </div>

      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={revoke}
          disabled={busy || others === 0}
          aria-busy={busy}
        >
          {busy ? (
            <>
              <Spinner />
              Signing out
            </>
          ) : (
            <>
              <LogOut className="size-3.5" aria-hidden />
              Sign out other devices
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
