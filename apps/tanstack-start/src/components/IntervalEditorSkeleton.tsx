import { Skeleton } from './ui/skeleton';

export function IntervalEditorSkeleton() {
	return (
		<div className="mx-auto w-full max-w-[680px] px-8 py-12">
			{/* Title skeleton */}
			<Skeleton className="mb-4 h-9 w-2/3" />

			{/* Properties row skeleton */}
			<div className="border-border mt-4 mb-8 flex items-center gap-4 border-b pb-6">
				<Skeleton className="h-7 w-24" />
				<Skeleton className="h-7 w-24" />
			</div>

			{/* Editor content skeleton */}
			<div className="min-h-[200px] space-y-3">
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-4/5" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-3/5" />
			</div>
		</div>
	);
}
