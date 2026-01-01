import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { IntervalList } from "../../components/IntervalList";
import { IntervalListSkeleton } from "../../components/IntervalListSkeleton";

export const Route = createFileRoute("/intervals/")({
  component: IntervalsIndexComponent,
});

function IntervalsIndexComponent() {
  return (
    <ClientOnly fallback={<IntervalListSkeleton />}>
      <IntervalList />
    </ClientOnly>
  );
}
