import { cn } from "@/lib/cn";

/**
 * Inline busy indicator. Sized in `em` so it tracks whatever text
 * it sits beside — a Button label, a table cell, a toast.
 *
 * Reduced motion is handled globally in globals.css (animations are
 * collapsed to ~0ms), which leaves a static ring. That still reads as
 * "waiting" next to the disabled control, so no extra branch here.
 */
export function Spinner({
  className,
  label = "Working",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block size-[1.05em] shrink-0 animate-spin rounded-full",
        "border-[1.5px] border-current border-t-transparent opacity-90",
        className,
      )}
    />
  );
}
