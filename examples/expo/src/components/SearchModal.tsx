import { useState, useEffect, useMemo } from "react";
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	Modal,
	FlatList,
	StyleSheet,
	Pressable,
	Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { prose } from "@trestleinc/replicate/client";
import { useIntervalsContext } from "@/contexts/IntervalsContext";
import { StatusIcon } from "./StatusIcon";
import type { Interval } from "@/types/interval";

const SEARCH_DEBOUNCE_MS = 150;

interface SearchModalProps {
	visible: boolean;
	onClose: () => void;
}

export function SearchModal({ visible, onClose }: SearchModalProps) {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const router = useRouter();
	const { collection, intervals } = useIntervalsContext();

	// Reset on open
	useEffect(() => {
		if (visible) {
			setQuery("");
			setDebouncedQuery("");
		}
	}, [visible]);

	// Debounce search
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);

	// Filter results
	const results = useMemo(() => {
		const sorted = [...intervals].sort((a, b) => b.updatedAt - a.updatedAt);

		if (!debouncedQuery.trim()) {
			return sorted.slice(0, 10); // Recent 10 when empty
		}

		const q = debouncedQuery.toLowerCase();
		return sorted
			.filter(i => {
				const textContent = prose.extract(i.description).toLowerCase();
				return i.title?.toLowerCase().includes(q) || textContent.includes(q);
			})
			.slice(0, 20);
	}, [intervals, debouncedQuery]);

	const handleSelect = (id: string) => {
		router.push(`/interval/${id}`);
		onClose();
	};

	const handleDelete = (interval: Interval) => {
		Alert.alert(
			"Delete Interval",
			`"${interval.title || "Untitled"}" will be permanently deleted.`,
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Delete",
					style: "destructive",
					onPress: () => collection.delete(interval.id),
				},
			],
		);
	};

	const handleCreateNew = () => {
		router.push("/interval/new");
		onClose();
	};

	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
			<Pressable style={styles.overlay} onPress={onClose}>
				<View style={styles.container} onStartShouldSetResponder={() => true}>
					{/* Search header */}
					<View style={styles.header}>
						<Ionicons name="search" size={18} color="#666" />
						<TextInput
							style={styles.input}
							value={query}
							onChangeText={setQuery}
							placeholder="Search intervals..."
							placeholderTextColor="#999"
							autoFocus
							returnKeyType="search"
						/>
						<TouchableOpacity
							onPress={onClose}
							hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
						>
							<Ionicons name="close" size={22} color="#666" />
						</TouchableOpacity>
					</View>

					{/* Create new option */}
					<TouchableOpacity style={styles.createRow} onPress={handleCreateNew} activeOpacity={0.7}>
						<View style={styles.createIcon}>
							<Ionicons name="add" size={18} color="hsl(25, 65%, 45%)" />
						</View>
						<Text style={styles.createText}>New Interval</Text>
					</TouchableOpacity>

					{/* Results */}
					<FlatList
						data={results}
						keyExtractor={item => item.id}
						style={styles.list}
						keyboardShouldPersistTaps="handled"
						ListEmptyComponent={
							<View style={styles.empty}>
								<Text style={styles.emptyText}>
									{debouncedQuery.trim() ? `No intervals found for "${query}"` : "No intervals yet"}
								</Text>
							</View>
						}
						renderItem={({ item }) => (
							<TouchableOpacity
								style={styles.row}
								onPress={() => handleSelect(item.id)}
								activeOpacity={0.7}
							>
								<StatusIcon status={item.status} size={16} />
								<View style={styles.rowContent}>
									<Text style={styles.rowTitle} numberOfLines={1}>
										{item.title || "Untitled"}
									</Text>
								</View>
								<TouchableOpacity
									onPress={() => handleDelete(item)}
									hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
									style={styles.deleteButton}
								>
									<Ionicons name="trash-outline" size={16} color="#999" />
								</TouchableOpacity>
							</TouchableOpacity>
						)}
					/>
				</View>
			</Pressable>
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0, 0, 0, 0.4)",
		justifyContent: "flex-start",
		paddingTop: 100,
	},
	container: {
		marginHorizontal: 16,
		backgroundColor: "hsl(45, 30%, 98%)",
		borderRadius: 12,
		maxHeight: "70%",
		overflow: "hidden",
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 8 },
		shadowOpacity: 0.15,
		shadowRadius: 24,
		elevation: 8,
	},
	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: "hsl(45, 10%, 88%)",
	},
	input: {
		flex: 1,
		fontSize: 16,
		color: "hsl(30, 15%, 15%)",
	},
	createRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: "hsl(45, 10%, 88%)",
		backgroundColor: "rgba(25, 65, 45, 0.04)",
	},
	createIcon: {
		width: 24,
		height: 24,
		borderRadius: 12,
		backgroundColor: "rgba(25, 65, 45, 0.1)",
		alignItems: "center",
		justifyContent: "center",
	},
	createText: {
		fontSize: 15,
		fontWeight: "600",
		color: "hsl(25, 65%, 45%)",
	},
	list: {
		maxHeight: 350,
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 16,
		paddingVertical: 14,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: "rgba(0,0,0,0.05)",
	},
	rowContent: {
		flex: 1,
		minWidth: 0,
	},
	rowTitle: {
		fontSize: 15,
		fontWeight: "500",
		color: "hsl(30, 15%, 15%)",
	},
	deleteButton: {
		padding: 4,
	},
	empty: {
		paddingVertical: 32,
		alignItems: "center",
	},
	emptyText: {
		color: "#666",
		fontSize: 14,
	},
});
