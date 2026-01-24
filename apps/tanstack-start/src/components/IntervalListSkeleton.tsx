export function IntervalListSkeleton() {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex-1 p-0">
				{Array.from({ length: 8 }).map((_, i) => (
					<div key={i} className="border-border flex items-center gap-3 border-b px-3 py-2">
						<div className="skeleton h-4 w-4 shrink-0 rounded-full" />
						<div className="skeleton h-4 flex-1" style={{ maxWidth: `${180 + (i % 3) * 60}px` }} />
						<div className="skeleton h-4 w-4 shrink-0" />
					</div>
				))}
			</div>
		</div>
	);
}
