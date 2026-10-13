"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { sessionChanged } from "@/lib/client-session";
import { cn } from "@/lib/cn";
import type { ApiErrorCode } from "@/lib/http";

type Failure = {
  ok: false;
  code: ApiErrorCode;
  message: string;
  attemptsLeft?: number;
  retryAfterSeconds?: number;
};

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * One input for all six digits: pasting the whole code just works, and
 * `autocomplete="one-time-code"` lets phones offer the code from the
 * email. The input only filters what is typed — every check that matters
 * (the code, its expiry, the attempt count) happens on the server.
 */
export function VerifyEmailForm({
  maskedEmail,
  codeExpiresAt: initialExpiry,
  resendAt: initialResendAt,
  codeActive: initialActive,
}: {
  maskedEmail: string;
  codeExpiresAt: number | null;
  resendAt: number;
  codeActive: boolean;
}) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNow();

  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(initialExpiry);
  const [resendAt, setResendAt] = useState(initialResendAt);
  const [active, setActive] = useState(initialActive);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [done, setDone] = useState(false);
  // State updates land a render later; this blocks a second request from
  // an autofill-submit and a button tap arriving together.
  const inFlight = useRef(false);

  const expired = active && expiresAt !== null && expiresAt <= now;
  const usable = active && !expired;
  const resendWait = Math.max(0, resendAt - now);

  async function submit(value: string) {
    if (inFlight.current || done) return;
    if (!/^\d{6}$/.test(value)) {
      // Keep a server answer ("that code isn't right") rather than
      // replacing it with a generic prompt when the box was just cleared.
      setError((current) => (value === "" && current ? current : "Enter the 6-digit code from the email."));
      inputRef.current?.focus();
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      const data = (await res.json()) as { ok: true; redirectTo: string } | Failure;

      if (!data.ok) {
        setError(data.message);
        if (data.code === "CODE_EXPIRED" || data.code === "CODE_LOCKED") setActive(false);
        if (data.code === "VERIFICATION_NOT_FOUND") setEnded(true);
        setCode("");
        inFlight.current = false;
        setBusy(false);
        inputRef.current?.focus();
        return;
      }

      setDone(true);
      sessionChanged();
      router.replace(data.redirectTo);
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function resend() {
    if (resending || resendWait > 0) return;
    setResending(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/auth/resend-verification", { method: "POST" });
      const data = (await res.json()) as
        | { ok: true; codeExpiresAt: number; resendAt: number }
        | Failure;

      if (!data.ok) {
        setError(data.message);
        if (data.retryAfterSeconds) setResendAt(Date.now() + data.retryAfterSeconds * 1000);
        if (data.code === "VERIFICATION_NOT_FOUND") setEnded(true);
      } else {
        setExpiresAt(data.codeExpiresAt);
        setResendAt(data.resendAt);
        setActive(true);
        setCode("");
        setNotice(`We sent a new code to ${maskedEmail}. Earlier codes no longer work.`);
        inputRef.current?.focus();
      }
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setResending(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border border-mint-400/25 bg-mint-400/[0.08] px-4 py-3.5">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-mint-400" aria-hidden />
        <div>
          <p className="text-[0.9375rem] font-semibold text-cloud-50">Email confirmed</p>
          <p className="mt-0.5 text-[0.875rem] text-cloud-300">Your account is ready. Taking you to it now…</p>
        </div>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(code);
      }}
      className="flex flex-col gap-4"
    >
      {error ? <FormAlert>{error}</FormAlert> : null}
      {notice ? <FormAlert tone="info">{notice}</FormAlert> : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-[0.875rem] font-medium text-cloud-50">
          Verification code
        </label>
        <input
          ref={inputRef}
          id={inputId}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          autoFocus
          disabled={ended}
          value={code}
          placeholder="••••••"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${inputId}-status`}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(digits);
            if (error) setError(null);
            // An autofilled code (several digits arriving at once) submits
            // itself; typing the sixth digit by hand waits for the button.
            if (digits.length === 6 && code.length < 5 && usable) {
              void submit(digits);
            }
          }}
          onPaste={(event) => {
            const digits = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
            if (digits.length === 6) {
              event.preventDefault();
              setCode(digits);
              if (usable) void submit(digits);
            }
          }}
          className={cn(
            "h-14 w-full rounded-lg border bg-white px-4 text-center text-[1.625rem] font-semibold tracking-[0.5em] text-cloud-50",
            "t-data outline-none transition-colors placeholder:text-cloud-400/60",
            "focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15",
            "disabled:cursor-not-allowed disabled:bg-ink-900",
            error ? "border-rose-400" : "border-ink-700 hover:border-zinc-300",
          )}
        />
        <p id={`${inputId}-status`} className="text-[0.875rem] text-cloud-400" aria-live="polite">
          {ended
            ? "This verification has ended."
            : !active
              ? "This code can't be used any more. Send a new code below."
              : expired
                ? "This code has expired. Send a new code below."
                : expiresAt
                  ? `The code expires in ${clock(expiresAt - now)}.`
                  : null}
        </p>
      </div>

      <Button type="submit" size="lg" disabled={busy || !usable || ended} aria-busy={busy}>
        {busy ? (
          <>
            <Spinner />
            Verifying
          </>
        ) : (
          "Verify email"
        )}
      </Button>

      {!ended ? (
        <p className="text-center text-[0.9375rem] text-cloud-300">
          Didn&apos;t get it? Check your spam folder, or{" "}
          {resendWait > 0 ? (
            <span className="text-cloud-400">send a new code in {clock(resendWait)}</span>
          ) : (
            <button
              type="button"
              onClick={() => void resend()}
              disabled={resending}
              className="font-medium text-azure-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 disabled:opacity-60"
            >
              {resending ? "sending…" : "send a new code"}
            </button>
          )}
          .
        </p>
      ) : null}
    </form>
  );
}
