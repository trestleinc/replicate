import { useState, useMemo } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import { useRouter, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useIntervalsContext } from "@/contexts/IntervalsContext";
import { useFilterContext } from "@/contexts/FilterContext";
import { IntervalRow } from "@/components/IntervalRow";
import { SearchModal } from "@/components/SearchModal";
import { FilterModal } from "@/components/FilterModal";

export default function IntervalsScreen() {
	const { intervals, isLoading } = useIntervalsContext();
	const router = useRouter();
	const { statusFilter, priorityFilter, hasActiveFilters } = useFilterContext();

	const [searchVisible, setSearchVisible] = useState(false);
	const [filterVisible, setFilterVisible] = useState(false);

	const filteredIntervals = useMemo(() => {
		let result = [...intervals];

		if (statusFilter) {
			result = result.filter(i => i.status === statusFilter);
		}
		if (priorityFilter) {
			result = result.filter(i => i.priority === priorityFilter);
		}

		return result.sort((a, b) => b.createdAt - a.createdAt);
	}, [intervals, statusFilter, priorityFilter]);

	if (isLoading) {
		return (
			<View style={styles.centered}>
				<Text style={styles.loadingText}>Loading intervals...</Text>
			</View>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					title: "Intervals",
					headerRight: () => (
						<View style={styles.headerRight}>
							<TouchableOpacity
								onPress={() => setSearchVisible(true)}
								hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
							>
								<Ionicons name="search" size={22} color="hsl(25, 65%, 45%)" />
							</TouchableOpacity>
							<TouchableOpacity
								onPress={() => setFilterVisible(true)}
								hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
							>
								<Ionicons
									name="options-outline"
									size={22}
									color={hasActiveFilters ? "hsl(25, 65%, 45%)" : "#666"}
								/>
							</TouchableOpacity>
						</View>
					),
				}}
			/>
			<View style={styles.container}>
				<FlatList
					data={filteredIntervals}
					keyExtractor={item => item.id}
					renderItem={({ item }) => <IntervalRow interval={item} />}
					contentContainerStyle={styles.list}
					ListEmptyComponent={
						<View style={styles.empty}>
							<Text style={styles.emptyText}>
								{intervals.length === 0 ? "No intervals yet" : "No intervals match your filters"}
							</Text>
							{intervals.length === 0 && (
								<Text style={styles.emptySubtext}>Create your first interval to get started</Text>
							)}
						</View>
					}
				/>
				<TouchableOpacity
					style={styles.fab}
					onPress={() => router.push("/interval/new")}
					activeOpacity={0.8}
				>
					<Text style={styles.fabText}>+</Text>
				</TouchableOpacity>
			</View>

			<SearchModal visible={searchVisible} onClose={() => setSearchVisible(false)} />
			<FilterModal visible={filterVisible} onClose={() => setFilterVisible(false)} />
		</>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	headerRight: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
	},
	centered: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	loadingText: {
		fontSize: 16,
		opacity: 0.6,
	},
	list: {
		paddingVertical: 8,
	},
	empty: {
		alignItems: "center",
		paddingTop: 60,
	},
	emptyText: {
		fontSize: 18,
		fontWeight: "600",
		marginBottom: 8,
	},
	emptySubtext: {
		fontSize: 14,
		opacity: 0.6,
	},
	fab: {
		position: "absolute",
		right: 20,
		bottom: 20,
		width: 56,
		height: 56,
		borderRadius: 28,
		backgroundColor: "hsl(25, 65%, 45%)",
		justifyContent: "center",
		alignItems: "center",
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 4 },
		shadowOpacity: 0.2,
		shadowRadius: 8,
		elevation: 4,
	},
	fabText: {
		fontSize: 28,
		color: "white",
		fontWeight: "300",
		marginTop: -2,
	},
});
