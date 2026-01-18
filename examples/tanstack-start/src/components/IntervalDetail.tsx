import { IntervalEditor } from "./IntervalEditor";
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
		<div className="flex-1 overflow-auto">
			<IntervalEditor
				intervalId={intervalId}
				collection={collection}
				interval={interval}
				onPropertyUpdate={handlePropertyUpdate}
			/>
			<CommentList intervalId={intervalId} />
		</div>
	);
}
