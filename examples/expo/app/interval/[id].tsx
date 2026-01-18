import { useState, useMemo, useCallback, useEffect } from "react";
import {
	View,
	Text,
	TextInput,
	ScrollView,
	TouchableOpacity,
	StyleSheet,
	Alert,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useIntervalsContext } from "@/contexts/IntervalsContext";
import { generateId } from "@/lib/utils";
import { CommentList } from "@/components/CommentList";
import { StatusPicker } from "@/components/StatusPicker";
import { PriorityPicker } from "@/components/PriorityPicker";
import { DescriptionEditor } from "@/components/DescriptionEditor";
import {
	Status,
	Priority,
	type Interval,
	type StatusValue,
	type PriorityValue,
} from "@/types/interval";
import { prose } from "@trestleinc/replicate/client";

export default function IntervalDetailScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const router = useRouter();
	const { collection, intervals } = useIntervalsContext();

	const isNew = id === "new";
	const [createdId, setCreatedId] = useState<string | null>(null);
	const [title, setTitle] = useState("");

	useEffect(() => {
		if (isNew && !createdId) {
			const newId = generateId();
			const now = Date.now();

			collection.insert({
				id: newId,
				title: "Untitled",
				description: prose.empty(),
				status: Status.TODO,
				priority: Priority.NONE,
				createdAt: now,
				updatedAt: now,
			});

			setCreatedId(newId);
		}
	}, [isNew, createdId, collection]);

	const currentId = isNew ? createdId : id;

	const currentInterval = useMemo(
		() => intervals.find(i => i.id === currentId),
		[intervals, currentId],
	);

	useEffect(() => {
		if (currentInterval) {
			setTitle(currentInterval.title);
		}
	}, [currentInterval?.title]);

	const handleTitleChange = useCallback((newTitle: string) => {
		setTitle(newTitle);
	}, []);

	const handleTitleBlur = useCallback(() => {
		if (!currentInterval || title === currentInterval.title) return;

		collection.update(currentInterval.id, (draft: Interval) => {
			draft.title = title.trim() || "Untitled";
			draft.updatedAt = Date.now();
		});
	}, [currentInterval, title, collection]);

	const handleStatusChange = useCallback(
		(status: StatusValue) => {
			if (!currentInterval) return;

			collection.update(currentInterval.id, (draft: Interval) => {
				draft.status = status;
				draft.updatedAt = Date.now();
			});
		},
		[currentInterval, collection],
	);

	const handlePriorityChange = useCallback(
		(priority: PriorityValue) => {
			if (!currentInterval) return;

			collection.update(currentInterval.id, (draft: Interval) => {
				draft.priority = priority;
				draft.updatedAt = Date.now();
			});
		},
		[currentInterval, collection],
	);

	const handleDelete = useCallback(() => {
		if (!currentInterval) return;

		Alert.alert("Delete Interval", "Are you sure you want to delete this interval?", [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Delete",
				style: "destructive",
				onPress: () => {
					collection.delete(currentInterval.id);
					router.back();
				},
			},
		]);
	}, [currentInterval, collection, router]);

	if (!currentInterval) {
		return (
			<View style={styles.centered}>
				<Text style={styles.notFound}>Loading...</Text>
			</View>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					title: "",
					headerBackTitle: "Back",
					headerRight: () => (
						<TouchableOpacity
							onPress={handleDelete}
							hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
						>
							<Ionicons name="trash-outline" size={22} color="hsl(0, 65%, 45%)" />
						</TouchableOpacity>
					),
				}}
			/>
			<ScrollView style={styles.container} contentContainerStyle={styles.content}>
				<TextInput
					style={styles.titleInput}
					value={title}
					onChangeText={handleTitleChange}
					onBlur={handleTitleBlur}
					placeholder="Untitled"
					placeholderTextColor="#999"
				/>

				<View style={styles.propertiesRow}>
					<StatusPicker value={currentInterval.status} onChange={handleStatusChange} />
					<PriorityPicker value={currentInterval.priority} onChange={handlePriorityChange} />
				</View>

				<View style={styles.field}>
					<Text style={styles.label}>Description</Text>
					<DescriptionEditor intervalId={currentInterval.id} />
				</View>

				<CommentList intervalId={currentInterval.id} />
			</ScrollView>
		</>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	centered: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	notFound: {
		fontSize: 16,
		opacity: 0.6,
	},
	titleInput: {
		fontSize: 24,
		fontWeight: "600",
		marginBottom: 16,
		padding: 0,
	},
	propertiesRow: {
		flexDirection: "row",
		gap: 12,
		marginBottom: 24,
	},
	field: {
		marginBottom: 24,
	},
	label: {
		fontSize: 14,
		fontWeight: "600",
		marginBottom: 8,
		opacity: 0.7,
	},
});
