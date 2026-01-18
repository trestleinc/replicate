import Svg, { Circle, Path } from "react-native-svg";
import { Status, type StatusValue } from "@/types/interval";

const statusColors: Record<StatusValue, string> = {
	[Status.BACKLOG]: "#6b7280",
	[Status.TODO]: "#3b82f6",
	[Status.IN_PROGRESS]: "#f59e0b",
	[Status.DONE]: "#22c55e",
	[Status.CANCELED]: "#ef4444",
};

interface StatusIconProps {
	status: StatusValue;
	size?: number;
}

export function StatusIcon({ status, size = 14 }: StatusIconProps) {
	const color = statusColors[status];

	if (status === Status.DONE) {
		return (
			<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
				<Circle cx="8" cy="8" r="7" stroke={color} strokeWidth={1.5} fill={color} />
				<Path
					d="M5 8l2 2 4-4"
					stroke="white"
					strokeWidth={1.5}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</Svg>
		);
	}

	if (status === Status.CANCELED) {
		return (
			<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
				<Circle cx="8" cy="8" r="7" stroke={color} strokeWidth={1.5} />
				<Path d="M5 8h6" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
			</Svg>
		);
	}

	if (status === Status.IN_PROGRESS) {
		return (
			<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
				<Circle cx="8" cy="8" r="7" stroke={color} strokeWidth={1.5} />
				<Path d="M8 1a7 7 0 0 1 0 14" fill={color} stroke={color} strokeWidth={1.5} />
			</Svg>
		);
	}

	const fillOpacity = status === Status.TODO ? 0.15 : 0;

	return (
		<Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
			<Circle
				cx="8"
				cy="8"
				r="7"
				stroke={color}
				strokeWidth={1.5}
				fill={color}
				fillOpacity={fillOpacity}
			/>
		</Svg>
	);
}
