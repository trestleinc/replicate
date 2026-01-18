import { Skeleton } from "./ui/skeleton";

export function IntervalEditorSkeleton() {
	return (
		<div className="max-w-[680px] mx-auto px-8 py-12 w-full">
			{/* Title skeleton */}
			<Skeleton className="h-9 w-2/3 mb-4" />

			{/* Properties row skeleton */}
			<div className="flex items-center gap-4 mt-4 mb-8 pb-6 border-b border-border">
				<Skeleton className="h-7 w-24" />
				<Skeleton className="h-7 w-24" />
			</div>

			{/* Editor content skeleton */}
			<div className="space-y-3 min-h-[200px]">
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-4/5" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-3/5" />
			</div>
		</div>
	);
}
