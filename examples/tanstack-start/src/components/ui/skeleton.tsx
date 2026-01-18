import { cn } from "@/lib/utils";

interface SkeletonProps extends React.ComponentProps<"div"> {
	delayed?: boolean;
}

function Skeleton({ className, delayed = false, ...props }: SkeletonProps) {
	return (
		<div
			data-slot="skeleton"
			className={cn("rounded-none", delayed ? "skeleton-delayed" : "skeleton-warm", className)}
			{...props}
		/>
	);
}

export { Skeleton };
