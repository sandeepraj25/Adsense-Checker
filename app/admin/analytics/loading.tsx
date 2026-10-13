import { AnalyticsSkeleton } from "@/components/admin/analytics/Skeleton";
import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="space-y-5">
      <div>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-8 w-64" />
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <AnalyticsSkeleton />
    </div>
  );
}
