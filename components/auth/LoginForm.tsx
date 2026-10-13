"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { Field, FormAlert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import type { ApiErrorCode } from "@/lib/http";
import { sessionChanged } from "@/lib/client-session";
import { validateEmail } from "@/lib/validate";

type Failure = {
  ok: false;
  code: ApiErrorCode;
  message: string;
  fields?: Record<string, string>;
  redirectTo?: string;
};

type Success = { ok: true; redirectTo?: string };

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    // Client-side checks are a convenience only — the route re-validates.
    const emailError = validateEmail(email);
    const errors: Record<string, string> = {};
    if (emailError) errors.email = emailError;
    if (!password) errors.password = "Enter your password";

    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    setBusy(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember, next }),
      });

      const data = (await res.json()) as Success | Failure;

      if (!data.ok) {
        // Right password for a sign-up that was never confirmed: a fresh
        // code is on its way, so continue on the verification page.
        if (data.code === "EMAIL_NOT_VERIFIED" && data.redirectTo === "/verify-email") {
          router.push("/verify-email");
          return;
        }
        if (data.fields) setFieldErrors(data.fields);
        setFormError(data.message);
        setBusy(false);
        return;
      }

      // Leave `busy` on: the session cookie is set, so navigate rather
      // than returning the form to an editable state.
      // Any navbar still holding "signed out" must re-read the session.
      sessionChanged();
      // Where to go is decided by the server from the account's role
      // (admins → /admin, customers → /dashboard, or the page they asked
      // for if they may see it). `next` is only the fallback for an
      // older server that does not send it.
      router.replace(data.redirectTo ?? (next || "/dashboard"));
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

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        spellCheck={false}
        value={email}
        error={fieldErrors.email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (fieldErrors.email) {
            setFieldErrors((f) => ({ ...f, email: "" }));
          }
        }}
        placeholder="you@yourdomain.com"
        required
      />

      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        revealable
        value={password}
        error={fieldErrors.password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (fieldErrors.password) {
            setFieldErrors((f) => ({ ...f, password: "" }));
          }
        }}
        placeholder="Your password"
        required
      />

      <label className="flex w-fit cursor-pointer items-center gap-2.5 text-[0.9375rem] text-cloud-200">
        <input
          type="checkbox"
          name="remember"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="size-4 rounded border-ink-700 accent-azure-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
        />
        Keep me signed in for 30 days
      </label>

      <Button
        type="submit"
        size="lg"
        disabled={busy}
        aria-busy={busy}
        className="mt-1"
      >
        {busy ? (
          <>
            <Spinner />
            Signing in
          </>
        ) : (
          "Log in"
        )}
      </Button>
    </form>
  );
}