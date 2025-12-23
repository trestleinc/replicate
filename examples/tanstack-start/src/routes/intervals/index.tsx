import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { IntervalList } from "../../components/IntervalList";
import { Skeleton } from "../../components/ui/skeleton";

export const Route = createFileRoute("/intervals/")({
  component: IntervalsIndexComponent,
});

function IntervalsIndexComponent() {
  return (
    <ClientOnly fallback={<IntervalListLoading />}>
      <IntervalList />
    </ClientOnly>
  );
}

function IntervalListLoading() {
  return (
    <div className="flex-1 flex flex-col">
      <div className="flex flex-col">
        {Array.from({ length: 5 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
          <div key={i} className="flex items-center gap-3 px-6 py-3">
            <Skeleton className="w-5 h-5 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
