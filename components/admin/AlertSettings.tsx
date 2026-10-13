"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

async function send(url: string, method: string, body?: unknown) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return ((await res.json().catch(() => null)) ?? { ok: false, message: "Unexpected answer from the server." }) as {
      ok: boolean;
      message?: string;
      fields?: Record<string, string>;
      summary?: string;
      delivered?: boolean;
      status?: string;
    };
  } catch {
    return { ok: false, message: "Couldn't reach the server." };
  }
}

/** The alert address and the abandonment wait. Validated again on the server. */
export function AlertSettingsForm({ email, graceMinutes }: { email: string | null; graceMinutes: number }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [value, setValue] = useState(email ?? "");
  const [grace, setGrace] = useState(String(graceMinutes));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "test" | "run" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const dirty = value.trim().toLowerCase() !== (email ?? "") || grace !== String(graceMinutes);

  async function save() {
    const errors: Record<string, string> = {};
    if (value.trim() && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.trim())) errors.alertEmail = "Enter a valid email address";
    const minutes = Number.parseInt(grace, 10);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) errors.graceMinutes = "From 5 to 1440 minutes";
    setFieldErrors(errors);
    setNotice(null);
    if (Object.keys(errors).length) return;
    setBusy("save");
    const result = await send("/api/admin/notifications", "PATCH", { alertEmail: value.trim(), graceMinutes: minutes });
    setBusy(null);
    if (!result.ok) {
      if (result.fields) setFieldErrors(result.fields);
      setNotice({ tone: "error", text: result.message ?? "Not saved." });
      return;
    }
    success("Saved", value.trim() ? `Alerts go to ${value.trim().toLowerCase()}.` : "Alerts are off.");
    setNotice({ tone: "ok", text: value.trim() ? "Saved. New alerts go to this address." : "Saved. Alerts are off until you add an address." });
    router.refresh();
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    const result = await send("/api/admin/notifications/test", "POST");
    setBusy(null);
    if (!result.ok) setNotice({ tone: "error", text: result.message ?? "The test was not sent." });
    else
      setNotice({
        tone: "ok",
        text: result.delivered
          ? `The provider accepted a test email to ${email}. Check that inbox (and spam).`
          : "Development mode: the test email was printed to the server log, not sent.",
      });
  }

  async function runNow() {
    setBusy("run");
    setNotice(null);
    const result = await send("/api/admin/notifications/run", "POST");
    setBusy(null);
    if (!result.ok) error("Job failed", result.message ?? "");
    else {
      setNotice({ tone: "ok", text: `Checked just now: ${result.summary}.` });
      router.refresh();
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <Field
          label="Payment & Checkout Alert Email"
          name="alertEmail"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={value}
          placeholder="alerts@yourdomain.com"
          error={fieldErrors.alertEmail}
          hint="Payment-failure and abandoned-checkout alerts go here. Leave empty to turn alerts off."
          disabled={busy !== null}
          onChange={(event) => {
            setValue(event.target.value);
            setFieldErrors((f) => ({ ...f, alertEmail: "" }));
          }}
        />
        <Field
          label="Abandoned after (minutes)"
          name="graceMinutes"
          type="number"
          inputMode="numeric"
          min={5}
          max={1440}
          value={grace}
          error={fieldErrors.graceMinutes}
          hint="With no Pay attempt. Default 30."
          disabled={busy !== null}
          onChange={(event) => {
            setGrace(event.target.value);
            setFieldErrors((f) => ({ ...f, graceMinutes: "" }));
          }}
        />
      </div>

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-[0.875rem] text-rose-400" : "text-[0.875rem] text-mint-400"}>
          {notice.text}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy !== null || !dirty} aria-busy={busy === "save"}>
          {busy === "save" ? <Spinner /> : null}
          Save changes
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null || !email || dirty} onClick={() => void test()}>
          {busy === "test" ? <Spinner /> : null}
          Send a test email
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void runNow()}>
          {busy === "run" ? <Spinner /> : null}
          Check for abandoned checkouts now
        </Button>
      </div>
    </form>
  );
}

export function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  const { success, error } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await send(`/api/admin/notifications/${id}/retry`, "POST");
        setBusy(false);
        if (!result.ok) error("Not retried", result.message ?? "");
        else {
          if (result.status === "sent") success("Sent");
          else error("Still not sent", "See the reason in the row.");
          router.refresh();
        }
      }}
    >
      {busy ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />}
      Retry
    </Button>
  );
}
