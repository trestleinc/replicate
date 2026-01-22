import { Skeleton } from './ui/skeleton';

function IntervalRowSkeleton() {
	return (
		<div className="border-border flex items-center gap-3 border-b px-6 py-3">
			{/* Status icon */}
			<Skeleton className="h-4 w-4 shrink-0 rounded-full" />

			{/* Title and preview */}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
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
		<div className="flex min-h-0 flex-1 flex-col">
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
