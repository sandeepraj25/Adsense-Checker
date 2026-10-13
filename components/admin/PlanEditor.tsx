"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

/**
 * The per-plan editor.
 *
 * Prices are shown here but edited on Admin → Pricing, which handles
 * INR and USD separately and asks for confirmation. This form never sends
 * a price, so saving a feature or limit change cannot move one. A feature
 * switched on here is added to the plan's card lines too, so the pricing
 * page cannot end up enforcing something it does not advertise.
 *
 * Nothing here decides anything. /api/admin/plans/[id] re-validates every
 * value, keeps Free at ₹0, and leaves subscriptions already sold alone.
 */

export type EditablePlan = {
  id: string;
  name: string;
  tagline: string;
  /** Display only, e.g. "₹399 · $5.99" or "₹399 · not offered in USD". */
  priceLabel: string;
  siteLimit: number;
  scanLimit: number;
  active: boolean;
  purchasable: boolean;
  featured: boolean;
  features: string[];
  showcase: string[];
  highlights: string[];
  subscribers: number;
  updatedAt: number;
  updatedBy: string | null;
};

export function PlanEditor({
  plan,
  featureMeta,
}: {
  plan: EditablePlan;
  featureMeta: { key: string; label: string; does: string; minPlan: string }[];
}) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);

  const [name, setName] = useState(plan.name);
  const [tagline, setTagline] = useState(plan.tagline);
  const [siteLimit, setSiteLimit] = useState(String(plan.siteLimit));
  const [scanLimit, setScanLimit] = useState(String(plan.scanLimit));
  const [active, setActive] = useState(plan.active);
  const [purchasable, setPurchasable] = useState(plan.purchasable);
  const [featured, setFeatured] = useState(plan.featured);
  const [features, setFeatures] = useState<string[]>(plan.features);
  const [highlights, setHighlights] = useState(plan.highlights.join("\n"));

  const isFree = plan.id === "free";

  function toggle(key: string) {
    setFeatures((current) =>
      current.includes(key)
        ? current.filter((entry) => entry !== key)
        : [...current, key],
    );
  }

  async function save() {
    if (busy) return;
    setBusy("save");

    // A feature the admin just enabled should appear on the card as well,
    // and one they turned off must not linger there. The server reconciles
    // too, but doing it here keeps the visible result predictable.
    const showcase = [
      ...plan.showcase.filter((key) => features.includes(key)),
      ...features.filter(
        (key) => !plan.features.includes(key) && !plan.showcase.includes(key),
      ),
    ];

    try {
      const res = await fetch(`/api/admin/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          tagline,
          siteLimit,
          scanLimit,
          active,
          ...(isFree ? {} : { purchasable }),
          featured,
          features,
          showcase,
          highlights: highlights
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const payload = (data ?? {}) as {
        ok?: boolean;
        message?: string;
        changed?: string[];
      };
      if (!res.ok || !payload.ok) {
        error("Not saved", payload.message ?? "The plan was not changed.");
        return;
      }
      success(
        payload.changed && payload.changed.length > 0
          ? `${name} updated`
          : "Nothing changed",
        payload.changed?.join("; "),
      );
      router.refresh();
    } catch {
      error("Could not reach the server", "The plan was not changed.");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (busy) return;
    setBusy("reset");
    try {
      const res = await fetch(`/api/admin/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const data: unknown = await res.json().catch(() => null);
      const payload = (data ?? {}) as { ok?: boolean; message?: string };
      if (!res.ok || !payload.ok) {
        error("Not reset", payload.message ?? "The plan was not changed.");
        return;
      }
      success(`${plan.name} restored to the shipped defaults`);
      router.refresh();
    } catch {
      error("Could not reach the server", "The plan was not changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="glass rounded-xl">
      <div className="flex flex-col gap-3 border-b border-ink-700 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-[1rem] font-medium text-cloud-50">
            {plan.name}
            <span className="t-data ml-2 text-[0.75rem] text-cloud-600">
              {plan.id}
            </span>
          </h2>
          <p className="mt-1 text-[0.75rem] text-cloud-600">
            {plan.subscribers} active subscription
            {plan.subscribers === 1 ? "" : "s"}
            {plan.updatedBy ? ` · last edited by ${plan.updatedBy}` : " · never edited"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="quiet" disabled={busy !== null} onClick={() => void reset()}>
            {busy === "reset" ? <Spinner className="size-4" /> : <RotateCcw className="size-4" />}
            Reset to defaults
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void save()}>
            {busy === "save" ? <Spinner className="size-4" /> : <Save className="size-4" />}
            Save {plan.name}
          </Button>
        </div>
      </div>

      <div className="space-y-5 px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.875rem] font-medium text-cloud-50">Price per month</span>
            <p className="flex h-11 items-center rounded-lg border border-ink-700 bg-ink-900 px-3.5 text-[0.9375rem] text-cloud-200">
              {plan.priceLabel}
            </p>
            <p className="text-[0.8125rem] text-cloud-400">
              {isFree ? (
                "The free tier is granted on signup, never sold."
              ) : (
                <>
                  Change INR and USD prices on{" "}
                  <Link href="/admin/pricing" className="font-medium text-azure-600 hover:underline">
                    Pricing
                  </Link>
                  .
                </>
              )}
            </p>
          </div>
        </div>

        <Field
          label="Tagline"
          value={tagline}
          onChange={(event) => setTagline(event.target.value)}
          hint="One line under the plan name on the pricing card."
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Websites allowed"
            type="number"
            min={1}
            value={siteLimit}
            onChange={(event) => setSiteLimit(event.target.value)}
          />
          <Field
            label="Article scans per month"
            type="number"
            min={1}
            value={scanLimit}
            onChange={(event) => setScanLimit(event.target.value)}
            hint="Resets on the renewal date. Not a lifetime allowance."
          />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium text-cloud-200">
            Card highlights
          </span>
          <textarea
            value={highlights}
            onChange={(event) => setHighlights(event.target.value)}
            rows={3}
            className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5 text-[0.9375rem] text-cloud-50 outline-none transition-all placeholder:text-cloud-600 focus:border-azure-500/60 focus:bg-ink-900 focus:ring-4 focus:ring-azure-500/12"
            placeholder={"1 website\n10 article scans per month"}
          />
          <span className="text-[0.8125rem] text-cloud-600">
            One per line, up to eight. These describe the limits in words.
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <Switch
            label="Offered on the pricing page"
            checked={active}
            onChange={setActive}
          />
          <Switch
            label={isFree ? "Sold at checkout (never, for Free)" : "Sold at checkout"}
            checked={isFree ? false : purchasable}
            disabled={isFree}
            onChange={setPurchasable}
          />
          <Switch
            label="Highlighted card"
            checked={featured}
            onChange={setFeatured}
          />
        </div>

        <div>
          <p className="text-[0.8125rem] font-medium text-cloud-200">
            Features included
          </p>
          <p className="mt-1 text-[0.75rem] leading-snug text-cloud-600">
            This is the enforced set, not a list of claims. Switching one on
            grants it to new subscriptions on this plan and makes the analysis
            engine run it; switching one off stops the work and locks the
            section in the report.
          </p>

          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {featureMeta.map((feature) => {
              const on = features.includes(feature.key);
              return (
                <li key={feature.key}>
                  <button
                    type="button"
                    onClick={() => toggle(feature.key)}
                    aria-pressed={on}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      on
                        ? "border-mint-400/25 bg-mint-400/[0.07]"
                        : "border-ink-700 bg-ink-900 hover:border-ink-700",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded border",
                        on
                          ? "border-mint-400/50 bg-mint-400/20 text-mint-400"
                          : "border-ink-700 text-transparent",
                      )}
                    >
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block text-[0.875rem]",
                          on ? "text-cloud-50" : "text-cloud-400",
                        )}
                      >
                        {feature.label}
                      </span>
                      <span className="mt-0.5 block text-[0.75rem] leading-snug text-cloud-600">
                        Ships on {feature.minPlan}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex items-center gap-2.5 rounded-xl border px-3 py-2 text-[0.8125rem] transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-55",
        checked
          ? "border-azure-500/40 bg-azure-500/10 text-azure-600"
          : "border-ink-700 bg-ink-900 text-cloud-400 hover:border-ink-700",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative h-4 w-7 shrink-0 rounded-full transition-colors",
          checked ? "bg-azure-500/70" : "bg-ink-900",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3 rounded-full bg-white transition-all",
            checked ? "left-3.5" : "left-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}
