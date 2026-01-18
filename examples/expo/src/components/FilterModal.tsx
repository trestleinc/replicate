import {
	View,
	Text,
	TouchableOpacity,
	Modal,
	ScrollView,
	StyleSheet,
	Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFilterContext } from "@/contexts/FilterContext";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import {
	Status,
	Priority,
	StatusLabels,
	PriorityLabels,
	type StatusValue,
	type PriorityValue,
} from "@/types/interval";

interface FilterModalProps {
	visible: boolean;
	onClose: () => void;
}

const statusOptions = Object.values(Status) as StatusValue[];
const priorityOptions = Object.values(Priority) as PriorityValue[];

export function FilterModal({ visible, onClose }: FilterModalProps) {
	const {
		statusFilter,
		priorityFilter,
		setStatusFilter,
		setPriorityFilter,
		clearFilters,
		hasActiveFilters,
	} = useFilterContext();

	const handleClearAll = () => {
		clearFilters();
	};

	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
			<Pressable style={styles.overlay} onPress={onClose}>
				<View style={styles.sheet} onStartShouldSetResponder={() => true}>
					<View style={styles.handle} />

					{/* Header */}
					<View style={styles.header}>
						<Text style={styles.title}>Filters</Text>
						{hasActiveFilters && (
							<TouchableOpacity
								onPress={handleClearAll}
								hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
							>
								<Text style={styles.clearText}>Clear all</Text>
							</TouchableOpacity>
						)}
					</View>

					<ScrollView showsVerticalScrollIndicator={false} style={styles.scrollView}>
						{/* Status Section */}
						<Text style={styles.sectionTitle}>STATUS</Text>
						<FilterOption
							label="All statuses"
							isSelected={statusFilter === null}
							onPress={() => setStatusFilter(null)}
						/>
						{statusOptions.map(status => (
							<FilterOption
								key={status}
								label={StatusLabels[status]}
								icon={<StatusIcon status={status} size={16} />}
								isSelected={statusFilter === status}
								onPress={() => setStatusFilter(status)}
							/>
						))}

						{/* Divider */}
						<View style={styles.divider} />

						{/* Priority Section */}
						<Text style={styles.sectionTitle}>PRIORITY</Text>
						<FilterOption
							label="All priorities"
							isSelected={priorityFilter === null}
							onPress={() => setPriorityFilter(null)}
						/>
						{priorityOptions.map(priority => (
							<FilterOption
								key={priority}
								label={PriorityLabels[priority]}
								icon={<PriorityIcon priority={priority} size={14} />}
								isSelected={priorityFilter === priority}
								onPress={() => setPriorityFilter(priority)}
							/>
						))}
					</ScrollView>

					{/* Done button */}
					<View style={styles.footer}>
						<TouchableOpacity style={styles.doneButton} onPress={onClose} activeOpacity={0.8}>
							<Text style={styles.doneText}>Done</Text>
						</TouchableOpacity>
					</View>
				</View>
			</Pressable>
		</Modal>
	);
}

interface FilterOptionProps {
	label: string;
	icon?: React.ReactNode;
	isSelected: boolean;
	onPress: () => void;
}

function FilterOption({ label, icon, isSelected, onPress }: FilterOptionProps) {
	return (
		<TouchableOpacity
			style={[styles.option, isSelected && styles.optionSelected]}
			onPress={onPress}
			activeOpacity={0.7}
		>
			{icon ? (
				<View style={styles.optionIcon}>{icon}</View>
			) : (
				<View style={styles.optionIconPlaceholder}>
					<Ionicons name="ellipse-outline" size={16} color="#999" />
				</View>
			)}
			<Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>{label}</Text>
			{isSelected && <Ionicons name="checkmark" size={18} color="hsl(25, 65%, 45%)" />}
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0, 0, 0, 0.4)",
		justifyContent: "flex-end",
	},
	sheet: {
		backgroundColor: "hsl(45, 30%, 98%)",
		borderTopLeftRadius: 20,
		borderTopRightRadius: 20,
		maxHeight: "80%",
	},
	handle: {
		width: 36,
		height: 4,
		backgroundColor: "#e5e5e5",
		borderRadius: 2,
		alignSelf: "center",
		marginTop: 12,
		marginBottom: 8,
	},
	header: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 20,
		paddingVertical: 12,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: "hsl(45, 10%, 88%)",
	},
	title: {
		fontSize: 17,
		fontWeight: "600",
		color: "hsl(30, 15%, 15%)",
	},
	clearText: {
		fontSize: 15,
		color: "hsl(25, 65%, 45%)",
		fontWeight: "500",
	},
	scrollView: {
		maxHeight: 400,
	},
	sectionTitle: {
		fontSize: 12,
		fontWeight: "600",
		color: "#666",
		letterSpacing: 0.5,
		paddingHorizontal: 20,
		paddingTop: 16,
		paddingBottom: 8,
	},
	option: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 20,
		paddingVertical: 14,
		gap: 12,
	},
	optionSelected: {
		backgroundColor: "rgba(25, 65, 45, 0.08)",
	},
	optionIcon: {
		width: 24,
		alignItems: "center",
	},
	optionIconPlaceholder: {
		width: 24,
		alignItems: "center",
	},
	optionText: {
		flex: 1,
		fontSize: 16,
		color: "hsl(30, 15%, 15%)",
	},
	optionTextSelected: {
		fontWeight: "600",
		color: "hsl(25, 65%, 45%)",
	},
	divider: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: "hsl(45, 10%, 88%)",
		marginVertical: 8,
		marginHorizontal: 20,
	},
	footer: {
		paddingHorizontal: 20,
		paddingTop: 12,
		paddingBottom: 40,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: "hsl(45, 10%, 88%)",
	},
	doneButton: {
		paddingVertical: 14,
		backgroundColor: "hsl(25, 65%, 45%)",
		borderRadius: 10,
		alignItems: "center",
	},
	doneText: {
		fontSize: 16,
		fontWeight: "600",
		color: "white",
	},
});
