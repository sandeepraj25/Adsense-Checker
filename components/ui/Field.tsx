"use client";

import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one input treatment used everywhere in the app: recessed ink well,
 * azure focus ring, mono for anything machine-shaped (URLs, IDs).
 * Errors are wired through aria-invalid + aria-describedby so screen
 * readers get the message, not just the red border.
 */
const fieldShell =
  "w-full rounded-lg border bg-white px-3.5 text-[0.9375rem] text-cloud-50 " +
  "placeholder:text-cloud-400 outline-none transition-colors duration-150 " +
  "hover:border-zinc-300 focus:border-azure-500 focus:ring-3 focus:ring-azure-500/15 " +
  "disabled:cursor-not-allowed disabled:bg-ink-900 disabled:text-cloud-300";

export type FieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "className" | "id"
> & {
  label: string;
  /** Validation message. Presence flips the field into its error state. */
  error?: string;
  /** Static helper text, shown only while there is no error. */
  hint?: string;
  /** Renders with the mono face — for URLs, report IDs, keys. */
  mono?: boolean;
  className?: string;
  /** Adds a show/hide toggle. Only meaningful with type="password". */
  revealable?: boolean;
};

export function Field({
  label,
  error,
  hint,
  mono = false,
  className,
  revealable = false,
  type = "text",
  ...rest
}: FieldProps) {
  const autoId = useId();
  const id = `f${autoId}`;
  const describedBy = error
    ? `${id}-error`
    : hint
      ? `${id}-hint`
      : undefined;

  const [revealed, setRevealed] = useState(false);
  const showToggle = revealable && type === "password";
  const resolvedType = showToggle && revealed ? "text" : type;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={id}
        className="text-[0.875rem] font-medium text-cloud-50"
      >
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          type={resolvedType}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            fieldShell,
            "h-11",
            mono && "t-data text-[0.875rem]",
            showToggle && "pr-11",
            error
              ? "border-rose-400 focus:border-rose-400 focus:ring-rose-400/15"
              : "border-ink-700",
          )}
          {...rest}
        />

        {showToggle ? (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide password" : "Show password"}
            className={cn(
              "absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center",
              "rounded-md text-cloud-400 transition-colors hover:text-cloud-50",
            )}
          >
            {revealed ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        ) : null}
      </div>

      {error ? (
        <p
          id={`${id}-error`}
          className="text-[0.8125rem] leading-snug text-rose-400"
        >
          {error}
        </p>
      ) : hint ? (
        <p
          id={`${id}-hint`}
          className="text-[0.8125rem] leading-snug text-cloud-600"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Form-level error — the things a single field can't own: bad credentials,
 * a rejected payment, a dead upstream.
 */
export function FormAlert({
  children,
  tone = "error",
}: {
  children: React.ReactNode;
  tone?: "error" | "info";
}) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-xl border px-3.5 py-3 text-[0.875rem] leading-snug",
        tone === "error"
          ? "border-rose-400/25 bg-rose-400/8 text-rose-400"
          : "border-azure-400/25 bg-azure-400/8 text-azure-600",
      )}
    >
      {children}
    </p>
  );
}
