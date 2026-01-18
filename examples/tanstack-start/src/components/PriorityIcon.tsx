import { Priority, PriorityLabels, type PriorityValue } from "../types/interval";
import { cn } from "@/lib/utils";

const priorityColors: Record<PriorityValue, string> = {
	[Priority.NONE]: "currentColor",
	[Priority.LOW]: "currentColor",
	[Priority.MEDIUM]: "#f59e0b", // amber-500
	[Priority.HIGH]: "#f97316", // orange-500
	[Priority.URGENT]: "#ef4444", // red-500
};

interface PriorityIconProps {
	priority: PriorityValue;
	size?: number;
	className?: string;
}

export function PriorityIcon({ priority, size = 14, className = "" }: PriorityIconProps) {
	const color = priorityColors[priority];
	const label = PriorityLabels[priority];

	// Number of filled bars based on priority
	const filledBars =
		priority === Priority.URGENT
			? 4
			: priority === Priority.HIGH
				? 3
				: priority === Priority.MEDIUM
					? 2
					: priority === Priority.LOW
						? 1
						: 0;

	return (
		<div
			className={cn("inline-flex items-center justify-center rounded-sm bg-border", className)}
			style={{ width: size + 6, height: size + 6 }}
		>
			<svg width={size} height={size} viewBox="0 0 16 16" fill="none" role="img" aria-label={label}>
				<title>{label}</title>
				{/* 4 vertical bars */}
				{[0, 1, 2, 3].map(i => (
					<rect
						key={i}
						x={1 + i * 4}
						y={12 - (i + 1) * 2.5}
						width={3}
						height={(i + 1) * 2.5}
						rx={0.5}
						fill={i < filledBars ? color : "var(--border)"}
					/>
				))}
			</svg>
		</div>
	);
}
