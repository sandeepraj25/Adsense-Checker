import { cn } from "@/lib/cn";

/**
 * Loading placeholder. `.skeleton` (globals.css) supplies the ink fill
 * and the travelling sheen; size and radius come from utilities so a
 * skeleton can be shaped to match whatever it stands in for.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("skeleton block h-4 w-full rounded-md", className)}
    />
  );
}

/** A few stacked lines of fake text, last one short like real prose. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <span className={cn("block space-y-2.5", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={i === lines - 1 ? "h-3.5 w-2/5" : "h-3.5"}
        />
      ))}
    </span>
  );
}

/** Panel-shaped placeholder for a card slot that hasn't resolved yet. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "glass rounded-xl p-5",
        "flex flex-col gap-4",
        className,
      )}
      aria-busy="true"
    >
      <Skeleton className="h-3 w-24 rounded-full" />
      <Skeleton className="h-7 w-2/3" />
      <SkeletonText lines={2} />
    </div>
  );
}
