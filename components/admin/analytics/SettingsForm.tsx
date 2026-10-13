"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ignoringThisBrowser, setIgnoreThisBrowser } from "@/components/analytics/track";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { AnalyticsSettings } from "@/lib/analytics/settings";

const RANGES = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
];

const field =
  "h-10 w-full rounded-lg border border-ink-700 bg-white px-3 text-[0.9375rem] text-cloud-50 focus-visible:border-azure-500 focus-visible:outline-2 focus-visible:outline-azure-500/30 disabled:opacity-60";

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[0.9375rem] font-medium text-cloud-50">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-[0.8125rem] leading-relaxed text-cloud-400">
          {hint}
        </p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={`${id}-hint`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 disabled:opacity-60",
          checked ? "bg-azure-500" : "bg-zinc-300",
        )}
      >
        <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
      </button>
    </div>
  );
}

export function AnalyticsSettingsForm({ initial, timezones }: { initial: AnalyticsSettings; timezones: string[] }) {
  const router = useRouter();
  const { success } = useToast();
  const [values, setValues] = useState(initial);
  const [ips, setIps] = useState(initial.internalIps.join("\n"));
  const [retention, setRetention] = useState(String(initial.retentionDays));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const set = <K extends keyof AnalyticsSettings>(key: K, value: AnalyticsSettings[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
  };

  async function save() {
    setBusy(true);
    setNotice(null);
    const body = {
      ...values,
      internalIps: ips.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
      retentionDays: Number.parseInt(retention, 10),
    };
    try {
      const res = await fetch("/api/admin/analytics/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; message?: string; fields?: Record<string, string> } | null;
      if (!data?.ok) {
        setErrors(data?.fields ?? {});
        setNotice({ tone: "error", text: data?.message ?? "Not saved." });
      } else {
        setErrors({});
        setNotice({ tone: "ok", text: "Saved. New settings apply to the next event and the next report." });
        success("Analytics settings saved");
        router.refresh();
      }
    } catch {
      setNotice({ tone: "error", text: "Couldn't reach the server. Nothing was saved." });
    }
    setBusy(false);
  }

  const err = (key: string) =>
    errors[key] ? (
      <p role="alert" className="mt-1 text-[0.8125rem] text-rose-400">
        {errors[key]}
      </p>
    ) : null;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-6"
    >
      <fieldset className="divide-y divide-ink-850" disabled={busy}>
        <legend className="sr-only">Tracking</legend>
        <Toggle id="an-enabled" label="Record visits and events" hint="Off: nothing new is recorded. Reports from records (accounts, scans, revenue) keep working." checked={values.enabled} onChange={(v) => set("enabled", v)} />
        <Toggle
          id="an-admins"
          label="Treat signed-in administrators as internal"
          hint="Visits while signed in as an admin don't count as customer traffic. Admin pages are never tracked either way."
          checked={values.excludeAdmins}
          onChange={(v) => set("excludeAdmins", v)}
        />
        <Toggle id="an-export" label="Allow CSV export" hint="Administrators can download reports. Every download is written to the audit log." checked={values.exportEnabled} onChange={(v) => set("exportEnabled", v)} />
        <Toggle
          id="an-export-email"
          label="Include email addresses in account exports"
          hint="Off by default: the accounts CSV then has ids and names only."
          checked={values.exportIncludesEmail}
          onChange={(v) => set("exportIncludesEmail", v)}
          disabled={!values.exportEnabled}
        />
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="an-tz" className="text-[0.875rem] font-medium text-cloud-50">
            Reporting timezone
          </label>
          <select id="an-tz" value={values.timezone} onChange={(e) => set("timezone", e.target.value)} className={cn(field, "mt-1.5")} disabled={busy} aria-invalid={Boolean(errors.timezone)}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[0.8125rem] text-cloud-400">Days, weeks and months in reports start at midnight here. Stored times stay in UTC.</p>
          {err("timezone")}
        </div>
        <div>
          <label htmlFor="an-range" className="text-[0.875rem] font-medium text-cloud-50">
            Default date range
          </label>
          <select id="an-range" value={values.defaultRange} onChange={(e) => set("defaultRange", e.target.value as AnalyticsSettings["defaultRange"])} className={cn(field, "mt-1.5")} disabled={busy}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {err("defaultRange")}
        </div>
        <div>
          <label htmlFor="an-retention" className="text-[0.875rem] font-medium text-cloud-50">
            Keep events for (days)
          </label>
          <input
            id="an-retention"
            type="number"
            inputMode="numeric"
            min={30}
            max={730}
            value={retention}
            onChange={(e) => {
              setRetention(e.target.value);
              setErrors((x) => ({ ...x, retentionDays: "" }));
            }}
            className={cn(field, "mt-1.5")}
            disabled={busy}
            aria-invalid={Boolean(errors.retentionDays)}
          />
          <p className="mt-1 text-[0.8125rem] text-cloud-400">30–730. Older visits and events are deleted automatically. Default 395 (about 13 months).</p>
          {err("retentionDays")}
        </div>
        <div>
          <label htmlFor="an-internal-mode" className="text-[0.875rem] font-medium text-cloud-50">
            Internal visits
          </label>
          <select id="an-internal-mode" value={values.internalMode} onChange={(e) => set("internalMode", e.target.value as AnalyticsSettings["internalMode"])} className={cn(field, "mt-1.5")} disabled={busy}>
            <option value="drop">Don&apos;t record them</option>
            <option value="flag">Record, but hide unless “Include internal traffic” is ticked</option>
          </select>
          {err("internalMode")}
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="an-ips" className="text-[0.875rem] font-medium text-cloud-50">
            Internal IP addresses
          </label>
          <textarea
            id="an-ips"
            rows={3}
            value={ips}
            onChange={(e) => {
              setIps(e.target.value);
              setErrors((x) => ({ ...x, internalIps: "" }));
            }}
            placeholder={"203.0.113.7\n198.51.100.0/24"}
            className={cn(field, "mt-1.5 h-auto py-2 font-mono text-[0.875rem]")}
            disabled={busy}
            aria-invalid={Boolean(errors.internalIps)}
          />
          <p className="mt-1 text-[0.8125rem] text-cloud-400">One per line — your office or test machines. IPv4 ranges like 198.51.100.0/24 work. Up to 25.</p>
          {err("internalIps")}
        </div>
      </div>

      <fieldset disabled={busy}>
        <legend className="text-[0.875rem] font-medium text-cloud-50">Privacy mode</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(
            [
              ["cookieless", "Cookie-free (default)", "Nothing is stored on visitors' devices and no banner is shown. Visitors are estimated per day; new vs returning can't be measured."],
              ["ask", "Ask visitors", "A small banner asks to remember the browser with a random ID. Only visitors who allow it are recognised on later days; everyone else is counted cookie-free."],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border px-3.5 py-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-azure-500",
                values.consentMode === value ? "border-azure-500/40 bg-azure-500/[0.05]" : "border-ink-700 hover:border-zinc-300",
              )}
            >
              <input type="radio" name="an-consent" value={value} checked={values.consentMode === value} onChange={() => set("consentMode", value)} className="mt-1 accent-azure-500" />
              <span>
                <span className="block text-[0.9375rem] font-medium text-cloud-50">{label}</span>
                <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-cloud-400">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {err("consentMode")}
      </fieldset>

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-[0.875rem] text-rose-400" : "text-[0.875rem] text-mint-400"}>
          {notice.text}
        </p>
      ) : null}

      <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>
        {busy ? <Spinner /> : null}
        Save settings
      </Button>
    </form>
  );
}

/** Excludes the admin's current browser even when signed out (e.g. testing the public site). */
export function IgnoreThisBrowser() {
  const [ignored, setIgnored] = useState<boolean | null>(null);
  useEffect(() => setIgnored(ignoringThisBrowser()), []);
  if (ignored === null) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[0.875rem] text-cloud-300">
        {ignored ? "This browser is excluded: it sends no analytics, even when signed out." : "This browser is counted when you're signed out."}
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setIgnoreThisBrowser(!ignored);
          setIgnored(!ignored);
        }}
      >
        {ignored ? "Count this browser again" : "Exclude this browser"}
      </Button>
    </div>
  );
}
