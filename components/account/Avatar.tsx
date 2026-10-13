import { cn } from "@/lib/cn";

/**
 * One avatar for every surface: dashboard sidebar, admin shell, public
 * navbar, settings. A photo when the account has one; otherwise the
 * default — the person's initials on a quiet indigo tint, so a new
 * account never shows a broken image or a generic silhouette.
 *
 * A plain <img> on purpose: photos are served by an authenticated route,
 * and next/image's optimiser fetches server-side without the visitor's
 * cookie, so it would always get a 404.
 */
const SIZES = {
  xs: "size-7 text-[0.75rem]",
  sm: "size-9 text-[0.8125rem]",
  md: "size-11 text-[0.9375rem]",
  lg: "size-20 text-[1.5rem]",
} as const;

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

export function Avatar({
  name,
  src,
  size = "sm",
  className,
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const base = cn(
    "inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold select-none",
    SIZES[size],
    className,
  );

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        aria-hidden
        width={256}
        height={256}
        className={cn(base, "border border-ink-700 bg-ink-850 object-cover")}
        draggable={false}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(base, "border border-azure-500/15 bg-azure-500/[0.08] text-azure-600")}
    >
      {initialsFor(name)}
    </span>
  );
}
