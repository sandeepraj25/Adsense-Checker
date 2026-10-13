"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Radar } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { normalizeDomain } from "@/lib/domain";

/**
 * Overview shortcut. It does not run the audit itself — it hands the
 * domain to /dashboard/checker with run=1, so there is exactly one
 * implementation of the run and one place the stage animation lives.
 */
export function QuickCheck({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const domain = normalizeDomain(url);
    if (!domain) {
      setError("Enter a domain like yourdomain.com");
      return;
    }

    setError(undefined);
    setBusy(true);
    router.push(`/dashboard/checker?url=${encodeURIComponent(domain)}&run=1`);
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 sm:flex-row sm:items-start"
    >
      <Field
        label="Website address"
        name="url"
        mono
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        placeholder="yourdomain.com"
        value={url}
        error={error}
        disabled={disabled}
        onChange={(event) => {
          setUrl(event.target.value);
          if (error) setError(undefined);
        }}
        className="flex-1"
      />

      <Button
        type="submit"
        size="md"
        disabled={disabled || busy}
        aria-busy={busy}
        className="sm:mt-[1.6rem]"
      >
        {busy ? (
          <>
            <Spinner />
            Starting
          </>
        ) : (
          <>
            <Radar className="size-4" aria-hidden />
            Check website
          </>
        )}
      </Button>
    </form>
  );
}
