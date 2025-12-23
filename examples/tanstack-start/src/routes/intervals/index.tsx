import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { IntervalList } from "../../components/IntervalList";

export const Route = createFileRoute("/intervals/")({
  component: IntervalsIndexComponent,
});

function IntervalsIndexComponent() {
  return (
    <ClientOnly fallback={null}>
      <IntervalList />
    </ClientOnly>
  );
}
