import { Skeleton } from "./ui/skeleton";

function IntervalRowSkeleton() {
	return (
		<div className="flex items-center gap-3 px-6 py-3 border-b border-border">
			{/* Status icon */}
			<Skeleton className="h-4 w-4 rounded-full shrink-0" />

			{/* Title and preview */}
			<div className="flex-1 min-w-0 flex flex-col gap-1">
				<Skeleton className="h-4 w-1/3" />
				<Skeleton className="h-3 w-2/3" />
			</div>

			{/* Priority icon */}
			<Skeleton className="h-4 w-4 shrink-0" />
		</div>
	);
}

export function IntervalListSkeleton() {
	return (
		<div className="flex-1 flex flex-col min-h-0">
			<div className="flex-1 overflow-auto">
				<div className="flex flex-col">
					<IntervalRowSkeleton />
					<IntervalRowSkeleton />
					<IntervalRowSkeleton />
					<IntervalRowSkeleton />
					<IntervalRowSkeleton />
				</div>
			</div>
		</div>
	);
}
