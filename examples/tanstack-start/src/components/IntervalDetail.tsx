import { IntervalEditor } from "./IntervalEditor";
import { IntervalProperties } from "./IntervalProperties";
import { CommentList } from "./CommentList";
import type { Interval } from "../types/interval";
import type { intervals } from "../collections/useIntervals";

interface IntervalDetailProps {
  intervalId: string;
  collection: ReturnType<typeof intervals.get>;
  interval: Interval;
}

export function IntervalDetail({ intervalId, collection, interval }: IntervalDetailProps) {
  const handlePropertyUpdate = (updates: Partial<Pick<Interval, "status" | "priority">>) => {
    collection.update(intervalId, (draft: Interval) => {
      if (updates.status !== undefined) draft.status = updates.status;
      if (updates.priority !== undefined) draft.priority = updates.priority;
      draft.updatedAt = Date.now();
    });
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main content */}
      <div className="flex-1 overflow-auto">
        <IntervalEditor
          intervalId={intervalId}
          collection={collection}
          interval={interval}
          onPropertyUpdate={handlePropertyUpdate}
        />
        <CommentList intervalId={intervalId} />
      </div>

      {/* Sidebar - hidden on mobile */}
      <aside className="hidden lg:block w-64 shrink-0 border-l border-border overflow-auto bg-card">
        <IntervalProperties interval={interval} onUpdate={handlePropertyUpdate} />
      </aside>
    </div>
  );
}
