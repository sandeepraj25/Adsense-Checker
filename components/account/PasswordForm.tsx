"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { Field, FormAlert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  PASSWORD_MIN,
  passwordStrength,
  validateConfirmPassword,
  validatePassword,
  type FieldErrors,
} from "@/lib/validate";

const meterTone = [
  "bg-ink-900",
  "bg-rose-400",
  "bg-amber-400",
  "bg-amber-400",
  "bg-mint-400",
];

/**
 * Password change. Requires the current password, so a hijacked session
 * cannot lock the owner out, and the server revokes every other session
 * once the change goes through.
 */
export function PasswordForm() {
  const router = useRouter();
  const { success, error: errorToast } = useToast();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const strength = passwordStrength(next);

  function clear(field: string) {
    setErrors((previous) => {
      if (!previous[field]) return previous;
      const copy = { ...previous };
      delete copy[field];
      return copy;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const found: FieldErrors = {};
    if (!current) found.currentPassword = "Enter your current password";

    const strengthProblem = validatePassword(next);
    if (strengthProblem) found.newPassword = strengthProblem;

    const mismatch = validateConfirmPassword(next, confirm);
    if (mismatch) found.confirmPassword = mismatch;

    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }

    setBusy(true);
    setErrors({});
    setFormError(undefined);

    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: current,
          newPassword: next,
          confirmPassword: confirm,
        }),
      });
      const data: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const failure = data as
          | { message?: string; fields?: FieldErrors }
          | null;
        if (failure?.fields) setErrors(failure.fields);
        if (!failure?.fields || Object.keys(failure.fields).length === 0) {
          setFormError(failure?.message ?? "The password was not changed.");
        }
        setBusy(false);
        return;
      }

      setCurrent("");
      setNext("");
      setConfirm("");
      setBusy(false);
      success(
        "Password changed",
        "Every other signed-in device has been logged out.",
      );
      router.refresh();
    } catch {
      setFormError("We could not reach the server. Nothing was changed.");
      errorToast("Network error");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {formError ? <FormAlert>{formError}</FormAlert> : null}

      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        revealable
        autoComplete="current-password"
        value={current}
        error={errors.currentPassword}
        onChange={(event) => {
          setCurrent(event.target.value);
          clear("currentPassword");
        }}
      />

      <div>
        <Field
          label="New password"
          name="newPassword"
          type="password"
          revealable
          autoComplete="new-password"
          value={next}
          error={errors.newPassword}
          hint={`At least ${PASSWORD_MIN} characters, mixing letters with numbers or symbols.`}
          onChange={(event) => {
            setNext(event.target.value);
            clear("newPassword");
          }}
        />

        {next.length > 0 ? (
          <div className="mt-2.5">
            <div className="flex gap-1.5" aria-hidden>
              {[0, 1, 2, 3].map((index) => (
                <span
                  key={index}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-300",
                    index < strength.score
                      ? meterTone[strength.score]
                      : "bg-ink-900",
                  )}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[0.75rem] text-cloud-600">
              {strength.label}
            </p>
          </div>
        ) : null}
      </div>

      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        revealable
        autoComplete="new-password"
        value={confirm}
        error={errors.confirmPassword}
        onChange={(event) => {
          setConfirm(event.target.value);
          clear("confirmPassword");
        }}
      />

      <div>
        <Button type="submit" size="md" disabled={busy} aria-busy={busy}>
          {busy ? (
            <>
              <Spinner />
              Changing
            </>
          ) : (
            "Change password"
          )}
        </Button>
      </div>
    </form>
  );
}
