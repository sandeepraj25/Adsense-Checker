"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { Field, FormAlert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { sessionChanged } from "@/lib/client-session";
import { cn } from "@/lib/cn";
import type { ApiErrorCode } from "@/lib/http";
import {
  PASSWORD_MIN,
  passwordStrength,
  validateConfirmPassword,
  validateEmail,
  validateName,
  validatePassword,
} from "@/lib/validate";

type Failure = {
  ok: false;
  code: ApiErrorCode;
  message: string;
  fields?: Record<string, string>;
};

const meterTone = [
  "bg-ink-900",
  "bg-rose-400",
  "bg-amber-400",
  "bg-amber-400",
  "bg-mint-400",
];

export function SignupForm({ next }: { next: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [busy, setBusy] = useState(false);

  const strength = useMemo(() => passwordStrength(password), [password]);

  function clearField(key: string) {
    setFieldErrors((f) => (f[key] ? { ...f, [key]: "" } : f));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    // Same validators the API uses, imported rather than re-written, so
    // the two can never disagree about what a valid password is.
    const errors: Record<string, string> = {};
    const nameError = validateName(name);
    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);
    const confirmError = validateConfirmPassword(password, confirm);
    if (nameError) errors.name = nameError;
    if (emailError) errors.email = emailError;
    if (passwordError) errors.password = passwordError;
    if (confirmError) errors.confirmPassword = confirmError;

    setFieldErrors(errors);
    setFormError(null);
    setEmailTaken(false);
    if (Object.keys(errors).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, confirmPassword: confirm, next }),
      });
      const data = (await res.json()) as
        | { ok: true; verification?: { redirectTo: string } }
        | Failure;

      if (!data.ok) {
        if (data.fields) setFieldErrors(data.fields);
        setEmailTaken(data.code === "EMAIL_TAKEN");
        setFormError(data.code === "EMAIL_TAKEN" ? null : data.message);
        setBusy(false);
        return;
      }

      // No account or session exists yet — only a pending sign-up waiting
      // for the emailed code. The return path travels with it server-side.
      if (data.verification) {
        router.push(data.verification.redirectTo);
        return;
      }

      // An older server that still signs people in directly.
      sessionChanged();
      router.replace(next);
      router.refresh();
    } catch {
      setFormError(
        "We could not reach the server. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {formError ? <FormAlert>{formError}</FormAlert> : null}

      {emailTaken ? (
        <FormAlert>
          An account already uses that email.{" "}
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="underline decoration-rose-400/50 underline-offset-4 hover:text-rose-300"
          >
            Log in instead
          </Link>
          .
        </FormAlert>
      ) : null}

      <Field
        label="Name"
        name="name"
        autoComplete="name"
        value={name}
        error={fieldErrors.name}
        onChange={(e) => {
          setName(e.target.value);
          clearField("name");
        }}
        placeholder="Your name"
        required
      />

      <Field
        label="Email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        spellCheck={false}
        value={email}
        error={fieldErrors.email}
        onChange={(e) => {
          setEmail(e.target.value);
          clearField("email");
          if (emailTaken) setEmailTaken(false);
        }}
        placeholder="you@yourdomain.com"
        required
      />

      <div>
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          revealable
          value={password}
          error={fieldErrors.password}
          hint={`At least ${PASSWORD_MIN} characters, with upper and lower case and a number.`}
          onChange={(e) => {
            setPassword(e.target.value);
            clearField("password");
            if (confirm) clearField("confirmPassword");
          }}
          placeholder="Choose a password"
          required
        />

        {password ? (
          <div className="mt-2.5 flex items-center gap-3">
            <div className="flex flex-1 gap-1" aria-hidden>
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-300",
                    step <= strength.score
                      ? meterTone[strength.score]
                      : "bg-ink-900",
                  )}
                />
              ))}
            </div>
            <span className="t-data text-[0.75rem] text-cloud-400">
              {strength.label}
            </span>
          </div>
        ) : null}
      </div>

      <Field
        label="Confirm password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        revealable
        value={confirm}
        error={fieldErrors.confirmPassword}
        onChange={(e) => {
          setConfirm(e.target.value);
          clearField("confirmPassword");
        }}
        placeholder="Re-enter your password"
        required
      />

      <Button type="submit" size="lg" disabled={busy} aria-busy={busy} className="mt-2">
        {busy ? (
          <>
            <Spinner />
            Sending your code
          </>
        ) : (
          "Create account"
        )}
      </Button>

      <p className="text-[0.8125rem] leading-relaxed text-cloud-600">
        Next, we'll email you a 6-digit code to confirm your address. The free plan is
        added once you've confirmed it — no card needed.
      </p>
    </form>
  );
}
