"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

type Option = { code: "USD" | "INR"; label: string; ready: boolean; problems: string[] };

/**
 * Picks the website currency. Saving asks for confirmation first, showing
 * what changes — the server asks again (409 until `confirmed: true`).
 */
export function CurrencySettingForm({ current, options }: { current: "USD" | "INR"; options: Option[] }) {
  const router = useRouter();
  const { success } = useToast();
  const [value, setValue] = useState(current);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = options.find((o) => o.code === value)!;

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/currency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: value, confirmed: true }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string } | null;
      if (!data?.ok) {
        setError(data?.message ?? "Not saved.");
      } else {
        success("Website currency changed", `Prices and checkout now use ${value}.`);
        setConfirming(false);
        router.refresh();
      }
    } catch {
      setError("Couldn't reach the server. Nothing was changed.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <label htmlFor="site-currency" className="text-[0.875rem] font-medium text-cloud-50">
          Default Website Currency
        </label>
        <select
          id="site-currency"
          value={value}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value as "USD" | "INR");
            setConfirming(false);
            setError(null);
          }}
          className="mt-1.5 h-10 w-full rounded-lg border border-ink-700 bg-white px-3 text-[0.9375rem] text-cloud-50 focus-visible:border-azure-500 focus-visible:outline-2 focus-visible:outline-azure-500/30"
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {!selected.ready ? (
        <div role="alert" className="flex gap-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-[0.875rem] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden />
          <div>
            <p className="font-semibold text-cloud-50">Customers can&apos;t buy every plan in {value} yet</p>
            <ul className="mt-1 list-disc pl-4 text-cloud-300">
              {selected.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div role="alertdialog" aria-labelledby="currency-confirm-title" className="rounded-xl border border-azure-500/25 bg-azure-500/[0.04] p-4">
          <p id="currency-confirm-title" className="font-semibold text-cloud-50">
            Switch the whole website to {value}?
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.875rem] leading-relaxed text-cloud-300">
            <li>The pricing page, homepage, checkout and upgrade prompts will show {value} prices only, from each plan&apos;s configured {value} price. Nothing is converted.</li>
            <li>A customer with a checkout page already open will be asked to reload before paying; nobody is charged a price they didn&apos;t see.</li>
            <li>Payments and invoices already made keep the currency they were paid in.</li>
            {!selected.ready ? <li className="font-medium text-amber-400">Plans without a {value} price, or with no gateway for {value}, can&apos;t be bought until that&apos;s fixed.</li> : null}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void apply()} disabled={busy} aria-busy={busy}>
              {busy ? <Spinner /> : null}
              Yes, switch to {value}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" disabled={value === current || busy} onClick={() => setConfirming(true)}>
          Save currency
        </Button>
      )}

      {error ? (
        <p role="alert" className="text-[0.875rem] text-rose-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
