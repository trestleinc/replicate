import { View, TextInput, StyleSheet } from "react-native";
import { useProseField } from "@/hooks/useProseField";

interface DescriptionEditorProps {
	intervalId: string;
}

export function DescriptionEditor({ intervalId }: DescriptionEditorProps) {
	const { text, isReady, handleChangeText } = useProseField(intervalId);

	if (!isReady) {
		return <View style={styles.container} />;
	}

	return (
		<View style={styles.container}>
			<TextInput
				style={styles.input}
				value={text}
				onChangeText={handleChangeText}
				placeholder="Add a description..."
				placeholderTextColor="#999"
				multiline
				textAlignVertical="top"
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		minHeight: 150,
	},
	input: {
		flex: 1,
		backgroundColor: "rgba(255, 255, 255, 0.8)",
		borderRadius: 8,
		borderWidth: 1,
		borderColor: "rgba(0, 0, 0, 0.1)",
		padding: 12,
		fontSize: 16,
		minHeight: 150,
	},
});
