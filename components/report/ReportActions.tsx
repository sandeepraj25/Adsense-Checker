"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Printer, RefreshCw, Trash2 } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

/**
 * Re-check / download / delete for a single report.
 *
 * Download is a print-to-PDF rather than a generated file: the report is
 * already laid out, the browser's own PDF export is better than anything
 * hand-rolled here, and it adds no dependency. Any collapsed <details>
 * is opened first so nothing silently vanishes from the printout.
 *
 * PDF export is a paid feature, so `canExport` comes from the plan the
 * report was run on. When it is false the button is replaced by a link to
 * the plan that includes it rather than being hidden — a missing button
 * reads as a bug, a named upgrade reads as a price.
 */
export function ReportActions({
  reportId,
  domain,
  canExport,
  exportPlanName,
}: {
  reportId: string;
  domain: string;
  /** Whether this report's plan includes PDF export. */
  canExport: boolean;
  /** Cheapest active plan that does, when it does not. */
  exportPlanName?: string;
}) {
  const router = useRouter();
  const { success, error: errorToast } = useToast();

  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function print() {
    for (const node of document.querySelectorAll("details")) {
      node.setAttribute("open", "");
    }
    window.print();
  }

  async function remove() {
    if (deleting) return;
    setDeleting(true);

    try {
      const response = await fetch(`/api/reports/${reportId}`, {
        method: "DELETE",
      });
      const data: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          data && typeof data === "object" && "message" in data
            ? String((data as { message: unknown }).message)
            : "The report could not be deleted.";
        errorToast(message);
        setDeleting(false);
        setConfirming(false);
        return;
      }

      success("Report deleted", `The ${domain} report has been removed.`);
      router.replace("/dashboard/reports");
      router.refresh();
    } catch {
      errorToast(
        "Network error",
        "We could not reach the server. The report was not deleted.",
      );
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="no-print glass flex flex-wrap items-center gap-3 rounded-xl px-4 py-3">
        <p className="text-[0.875rem] text-cloud-200">
          Delete this report permanently?
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={remove}
            disabled={deleting}
            aria-busy={deleting}
            className="border-rose-400/30 text-rose-400 hover:border-rose-400/50"
          >
            {deleting ? (
              <>
                <Spinner />
                Deleting
              </>
            ) : (
              "Yes, delete"
            )}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => setConfirming(false)}
            disabled={deleting}
          >
            Keep it
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="no-print flex flex-wrap gap-2.5">
      <Button
        size="sm"
        onClick={() =>
          router.push(
            `/dashboard/checker?url=${encodeURIComponent(domain)}&run=1`,
          )
        }
      >
        <RefreshCw className="size-3.5" aria-hidden />
        Re-check
      </Button>

      {canExport ? (
        <Button size="sm" variant="ghost" onClick={print}>
          <Printer className="size-3.5" aria-hidden />
          Export PDF
        </Button>
      ) : (
        <ButtonLink href="/pricing" size="sm" variant="ghost">
          <Lock className="size-3.5" aria-hidden />
          PDF export{exportPlanName ? ` on ${exportPlanName}` : ""}
        </ButtonLink>
      )}

      <Button size="sm" variant="quiet" onClick={() => setConfirming(true)}>
        <Trash2 className="size-3.5" aria-hidden />
        Delete
      </Button>
    </div>
  );
}
