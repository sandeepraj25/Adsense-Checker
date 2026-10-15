"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { formatMoney, minorToInput, parseMajorToMinor } from "@/lib/money";
import { yearlyDiscountPercent } from "@/lib/billing/cycle";

export type PricingRow = {
  id: string;
  name: string;
  inrMinor: number;
  usdMinor: number | null;
  /** Twelve-month prices; null = not offered yearly in that currency. */
  yearlyInrMinor: number | null;
  yearlyUsdMinor: number | null;
  yearlyEnabled: boolean;
  yearlyBadge: string | null;
  interval: string;
  status: { label: string; tone: "pass" | "neutral" | "warn" };
  subscribers: number;
  updatedAt: number | null;
  updatedLabel: string;
  isFree: boolean;
};

type Pending = { summary: string; activeSubscribers: number };

/**
 * One plan per row, INR and USD side by side. Editing is inline; saving
 * asks the server first, which answers with a summary of what would
 * change, and only a second, confirmed request writes it.
 *
 * Validation here is a convenience — the route parses and checks every
 * value again and is the only thing that decides.
 */
export function PricingTable({ rows }: { rows: PricingRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-ink-700 bg-white">
      <div
        className="hidden border-b border-ink-700 bg-ink-900 px-5 py-2.5 text-[0.8125rem] font-medium text-cloud-400 md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_7rem] md:gap-4"
        aria-hidden
      >
        <span>Plan</span>
        <span className="text-right">INR price</span>
        <span className="text-right">USD price</span>
        <span>Billing</span>
        <span>Status</span>
        <span className="sr-only">Actions</span>
      </div>
      <ul className="divide-y divide-ink-700">
        {rows.map((row) => (
          <PriceRow key={row.id} row={row} />
        ))}
      </ul>
    </div>
  );
}

function PriceRow({ row }: { row: PricingRow }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [editing, setEditing] = useState(false);
  const [inr, setInr] = useState(minorToInput(row.inrMinor));
  const [usd, setUsd] = useState(row.usdMinor === null ? "" : minorToInput(row.usdMinor));
  const [yInr, setYInr] = useState(row.yearlyInrMinor === null ? "" : minorToInput(row.yearlyInrMinor));
  const [yUsd, setYUsd] = useState(row.yearlyUsdMinor === null ? "" : minorToInput(row.yearlyUsdMinor));
  const [yOn, setYOn] = useState(row.yearlyEnabled);
  const [badge, setBadge] = useState(row.yearlyBadge ?? "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setEditing(false);
    setInr(minorToInput(row.inrMinor));
    setUsd(row.usdMinor === null ? "" : minorToInput(row.usdMinor));
    setYInr(row.yearlyInrMinor === null ? "" : minorToInput(row.yearlyInrMinor));
    setYUsd(row.yearlyUsdMinor === null ? "" : minorToInput(row.yearlyUsdMinor));
    setYOn(row.yearlyEnabled);
    setBadge(row.yearlyBadge ?? "");
    setFieldErrors({});
    setFormError(null);
    setPending(null);
  }

  function localErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const inrMinor = parseMajorToMinor(inr);
    if (inrMinor === null) errors.inr = "Enter an amount like 399 or 399.50.";
    else if (inrMinor === 0) errors.inr = "A paid plan needs a price above ₹0.";
    if (usd.trim() !== "") {
      const usdMinor = parseMajorToMinor(usd);
      if (usdMinor === null) errors.usd = "Enter an amount like 5.99.";
      else if (usdMinor === 0) errors.usd = "Leave it empty to stop offering this plan in USD.";
    }
    for (const [key, value] of [["yearlyInr", yInr], ["yearlyUsd", yUsd]] as const) {
      if (value.trim() === "") continue;
      const minor = parseMajorToMinor(value);
      if (minor === null || minor === 0) errors[key] = "Enter an amount above zero, or leave it empty.";
    }
    if (yOn && yInr.trim() === "" && yUsd.trim() === "") errors.yearlyInr = "Set a yearly price to offer yearly billing.";
    if (badge.trim().length > 40) errors.yearlyBadge = "Up to 40 characters.";
    return errors;
  }

  async function send(confirmed: boolean) {
    if (busy) return;
    const errors = localErrors();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/admin/pricing/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inr,
          usd: usd.trim() === "" ? null : usd,
          yearlyInr: yInr.trim() === "" ? null : yInr,
          yearlyUsd: yUsd.trim() === "" ? null : yUsd,
          yearlyEnabled: yOn,
          yearlyBadge: badge.trim() === "" ? null : badge.trim(),
          confirmed,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: true; changed: string[] }
        | {
            ok: false;
            code: string;
            message: string;
            fields?: Record<string, string>;
            summary?: string;
            activeSubscribers?: number;
          }
        | null;

      if (!data) {
        setFormError("The server sent an unexpected answer. Nothing was saved.");
      } else if (!data.ok && data.code === "CONFIRMATION_REQUIRED") {
        setPending({ summary: data.summary ?? "", activeSubscribers: data.activeSubscribers ?? 0 });
      } else if (!data.ok) {
        if (data.fields) setFieldErrors(data.fields);
        setFormError(data.message);
        setPending(null);
      } else if (data.changed.length === 0) {
        reset();
      } else {
        success("Prices saved", `${row.name}: ${data.changed.join("; ")}`);
        reset();
        router.refresh();
      }
    } catch {
      setFormError("We could not reach the server. Nothing was saved.");
      toastError("Not saved", "Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-5 py-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_7rem] md:items-center">
        <div className="col-span-2 md:col-span-1">
          <p className="text-[0.9375rem] font-semibold text-cloud-50">{row.name}</p>
          <p className="mt-0.5 font-mono text-[0.8125rem] text-cloud-400">{row.id}</p>
        </div>

        <PriceCell label="INR price" value={formatMoney(row.inrMinor, "INR")} />
        <PriceCell
          label="USD price"
          value={row.usdMinor === null ? null : formatMoney(row.usdMinor, "USD")}
        />

        <div>
          <p className="text-[0.8125rem] text-cloud-400 md:hidden">Billing</p>
          <p className="text-[0.9375rem] text-cloud-200">{row.yearlyEnabled ? "Monthly + yearly" : row.interval}</p>
          {row.yearlyEnabled ? (
            <p className="mt-0.5 text-[0.8125rem] leading-snug text-cloud-400">
              {[
                row.yearlyInrMinor !== null ? `${formatMoney(row.yearlyInrMinor, "INR")}/yr${discountNote(row.inrMinor, row.yearlyInrMinor)}` : null,
                row.yearlyUsdMinor !== null ? `${formatMoney(row.yearlyUsdMinor, "USD")}/yr${discountNote(row.usdMinor, row.yearlyUsdMinor)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {row.yearlyBadge ? ` · “${row.yearlyBadge}”` : ""}
            </p>
          ) : null}
        </div>

        <div>
          <p className="text-[0.8125rem] text-cloud-400 md:hidden">Status</p>
          <Badge tone={row.status.tone}>{row.status.label}</Badge>
          <p className="mt-1 text-[0.8125rem] text-cloud-400">{row.updatedLabel}</p>
        </div>

        <div className="col-span-2 md:col-span-1 md:text-right">
          {row.isFree ? (
            <p className="text-[0.8125rem] text-cloud-400">Always free</p>
          ) : !editing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${row.name} prices`}
            >
              <Pencil className="size-3.5" aria-hidden />
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <form
          className="mt-4 rounded-lg border border-ink-700 bg-ink-900 p-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void send(false);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="INR per month (₹)"
              name={`${row.id}-inr`}
              inputMode="decimal"
              value={inr}
              error={fieldErrors.inr}
              hint="Paise allowed, e.g. 399 or 399.50."
              disabled={pending !== null}
              onChange={(event) => setInr(event.target.value)}
            />
            <Field
              label="USD per month ($)"
              name={`${row.id}-usd`}
              inputMode="decimal"
              value={usd}
              error={fieldErrors.usd}
              hint="Leave empty to not offer this plan in USD."
              placeholder="Not offered"
              disabled={pending !== null}
              onChange={(event) => setUsd(event.target.value)}
            />
          </div>

          <fieldset className="mt-4 border-t border-ink-700 pt-4" disabled={pending !== null}>
            <legend className="sr-only">Yearly billing</legend>
            <label className="flex items-center gap-2.5 text-[0.9375rem] font-medium text-cloud-50">
              <input type="checkbox" checked={yOn} onChange={(event) => setYOn(event.target.checked)} className="size-4 accent-azure-500" />
              Offer yearly billing for {row.name}
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field
                label="INR per year (₹)"
                name={`${row.id}-yearly-inr`}
                inputMode="decimal"
                value={yInr}
                error={fieldErrors.yearlyInr}
                hint={liveDiscount(inr, yInr) ?? "Twelve months, paid once."}
                placeholder="Not offered"
                onChange={(event) => setYInr(event.target.value)}
              />
              <Field
                label="USD per year ($)"
                name={`${row.id}-yearly-usd`}
                inputMode="decimal"
                value={yUsd}
                error={fieldErrors.yearlyUsd}
                hint={liveDiscount(usd, yUsd) ?? "Leave empty to not offer yearly in USD."}
                placeholder="Not offered"
                onChange={(event) => setYUsd(event.target.value)}
              />
              <Field
                label="Yearly badge (optional)"
                name={`${row.id}-yearly-badge`}
                value={badge}
                error={fieldErrors.yearlyBadge}
                hint="e.g. 2 months free"
                maxLength={40}
                onChange={(event) => setBadge(event.target.value)}
              />
            </div>
          </fieldset>

          {formError ? (
            <p role="alert" className="mt-3 text-[0.875rem] text-rose-400">
              {formError}
            </p>
          ) : null}

          {pending ? (
            <div
              role="alertdialog"
              aria-labelledby={`${row.id}-confirm-title`}
              className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] p-4"
            >
              <p id={`${row.id}-confirm-title`} className="flex items-center gap-2 text-[0.9375rem] font-semibold text-cloud-50">
                <AlertTriangle className="size-4 text-amber-400" aria-hidden />
                Confirm the new {row.name} prices
              </p>
              <p className="mt-1.5 text-[0.9375rem] text-cloud-200">{pending.summary}</p>
              <p className="mt-1.5 text-[0.875rem] text-cloud-300">
                New purchases pay the new price straight away.{" "}
                {pending.activeSubscribers > 0
                  ? `${pending.activeSubscribers} active ${pending.activeSubscribers === 1 ? "subscription keeps" : "subscriptions keep"} the amount and currency already paid.`
                  : "No active subscriptions are on this plan."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => void send(true)} disabled={busy} aria-busy={busy}>
                  {busy ? <Spinner /> : null}
                  Confirm and save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)} disabled={busy}>
                  Back to editing
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>
                {busy ? <Spinner /> : null}
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={reset} disabled={busy}>
                Cancel
              </Button>
            </div>
          )}
        </form>
      ) : null}
    </li>
  );
}

/** " · save 17%" against twelve monthly payments, or "" when there is no saving. */
function discountNote(monthly: number | null, yearly: number | null): string {
  const pct = yearlyDiscountPercent(monthly, yearly);
  return pct ? ` · save ${pct}%` : "";
}

/** The discount for the amounts being typed, for the field hint. */
function liveDiscount(monthlyInput: string, yearlyInput: string): string | null {
  if (yearlyInput.trim() === "") return null;
  const monthly = parseMajorToMinor(monthlyInput);
  const yearly = parseMajorToMinor(yearlyInput);
  if (yearly === null || yearly === 0) return null;
  const pct = yearlyDiscountPercent(monthly, yearly);
  return pct ? `Saves ${pct}% vs 12 monthly payments.` : "No saving vs 12 monthly payments.";
}

function PriceCell({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="md:text-right">
      <p className="text-[0.8125rem] text-cloud-400 md:hidden">{label}</p>
      {value === null ? (
        <p className="text-[0.9375rem] text-cloud-400">Not offered</p>
      ) : (
        <p className="t-data text-[1rem] font-semibold text-cloud-50">
          {value}
          <span className="ml-0.5 text-[0.8125rem] font-normal text-cloud-400">/mo</span>
        </p>
      )}
    </div>
  );
}
