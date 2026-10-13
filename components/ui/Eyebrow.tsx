import { cn } from "@/lib/cn";

/**
 * Structural label. Carries real taxonomy (a review dimension, a step
 * index) — never decoration.
 */
export function Eyebrow({
  children,
  className,
  dot = false,
}: {
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "t-eyebrow inline-flex items-center gap-2.5 text-cloud-400",
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className="grad-brand size-1.5 shrink-0 rounded-full"
        />
      ) : null}
      {children}
    </span>
  );
}
