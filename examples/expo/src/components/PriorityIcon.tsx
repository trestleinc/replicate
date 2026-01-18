import { View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { Priority, type PriorityValue } from "@/types/interval";

const priorityColors: Record<PriorityValue, string> = {
	[Priority.NONE]: "#9ca3af",
	[Priority.LOW]: "#9ca3af",
	[Priority.MEDIUM]: "#f59e0b",
	[Priority.HIGH]: "#f97316",
	[Priority.URGENT]: "#ef4444",
};

interface PriorityIconProps {
	priority: PriorityValue;
	size?: number;
}

export function PriorityIcon({ priority, size = 14 }: PriorityIconProps) {
	const color = priorityColors[priority];

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
		<View
			style={{
				width: size + 6,
				height: size + 6,
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: "rgba(0,0,0,0.05)",
				borderRadius: 4,
			}}
		>
			<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
				{[0, 1, 2, 3].map(i => (
					<Rect
						key={i}
						x={1 + i * 4}
						y={12 - (i + 1) * 2.5}
						width={3}
						height={(i + 1) * 2.5}
						rx={0.5}
						fill={i < filledBars ? color : "#e5e7eb"}
					/>
				))}
			</Svg>
		</View>
	);
}
