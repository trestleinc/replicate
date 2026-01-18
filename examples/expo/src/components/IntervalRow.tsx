import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import type { Interval } from "@/types/interval";

interface IntervalRowProps {
	interval: Interval;
}

export function IntervalRow({ interval }: IntervalRowProps) {
	const router = useRouter();

	return (
		<TouchableOpacity
			style={styles.row}
			onPress={() => router.push(`/interval/${interval.id}`)}
			activeOpacity={0.7}
		>
			<View style={styles.statusContainer}>
				<StatusIcon status={interval.status} size={16} />
			</View>

			<View style={styles.content}>
				<Text style={styles.title} numberOfLines={1}>
					{interval.title || "Untitled"}
				</Text>
			</View>

			<View style={styles.priorityContainer}>
				<PriorityIcon priority={interval.priority} size={14} />
			</View>
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingVertical: 12,
		backgroundColor: "white",
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: "rgba(0,0,0,0.1)",
	},
	statusContainer: {
		marginRight: 12,
	},
	content: {
		flex: 1,
		minWidth: 0,
	},
	title: {
		fontSize: 15,
		fontWeight: "500",
		color: "#1f2937",
	},
	priorityContainer: {
		marginLeft: 12,
	},
});
