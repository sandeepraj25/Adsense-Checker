import { Skeleton } from "@/components/ui/Skeleton";

/** Placeholder shaped like the dashboard while a report is computed. */
export function AnalyticsSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading analytics">
      <span className="sr-only" role="status">
        Loading analytics…
      </span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="glass rounded-xl px-4 py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-20" />
            <Skeleton className="mt-3 h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="glass rounded-xl p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-5 h-48 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
