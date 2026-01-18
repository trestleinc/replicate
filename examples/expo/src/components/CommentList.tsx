import { useMemo, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { useLiveQuery } from "@tanstack/react-db";
import { comments as commentsLazy } from "@/collections/useComments";
import { generateId } from "@/lib/utils";

interface CommentListProps {
	intervalId: string;
}

export function CommentList({ intervalId }: CommentListProps) {
	const commentsCollection = commentsLazy.get();
	const { data: allComments = [], isLoading } = useLiveQuery(commentsCollection);

	const filteredComments = useMemo(() => {
		return allComments
			.filter(c => c.intervalId === intervalId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}, [allComments, intervalId]);

	const handleNewComment = (text: string) => {
		const id = generateId();
		const now = Date.now();

		commentsCollection.insert({
			id,
			intervalId,
			body: text,
			createdAt: now,
			updatedAt: now,
		});
	};

	return (
		<View style={styles.container}>
			<Text style={styles.title}>Comments</Text>

			{isLoading ? (
				<Text style={styles.emptyText}>Loading...</Text>
			) : filteredComments.length === 0 ? (
				<Text style={styles.emptyText}>No comments yet</Text>
			) : (
				<View style={styles.list}>
					{filteredComments.map(comment => (
						<CommentItem key={comment.id} comment={comment} />
					))}
				</View>
			)}

			<NewCommentInput onSubmit={handleNewComment} />
		</View>
	);
}

interface CommentItemProps {
	comment: { id: string; body: string; createdAt: number };
}

function CommentItem({ comment }: CommentItemProps) {
	const date = new Date(comment.createdAt).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});

	return (
		<View style={styles.commentRow}>
			<Text style={styles.commentText}>{comment.body}</Text>
			<Text style={styles.commentDate}>{date}</Text>
		</View>
	);
}

interface NewCommentInputProps {
	onSubmit: (text: string) => void;
}

function NewCommentInput({ onSubmit }: NewCommentInputProps) {
	const [text, setText] = useState("");

	const handleSubmit = () => {
		if (text.trim()) {
			onSubmit(text.trim());
			setText("");
		}
	};

	return (
		<View style={styles.inputContainer}>
			<TextInput
				style={styles.input}
				value={text}
				onChangeText={setText}
				placeholder="Add a comment..."
				placeholderTextColor="#aaa"
				multiline
			/>
			<TouchableOpacity
				style={[styles.submitButton, !text.trim() && styles.submitButtonDisabled]}
				onPress={handleSubmit}
				disabled={!text.trim()}
			>
				<Text style={[styles.submitButtonText, !text.trim() && styles.submitButtonTextDisabled]}>
					Post
				</Text>
			</TouchableOpacity>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: "rgba(0,0,0,0.1)",
		paddingTop: 16,
		marginTop: 20,
	},
	title: {
		fontSize: 13,
		fontWeight: "600",
		marginBottom: 10,
		color: "#888",
		textTransform: "uppercase",
		letterSpacing: 0.5,
	},
	emptyText: {
		fontSize: 13,
		color: "#aaa",
	},
	list: {},
	commentRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		paddingLeft: 10,
		borderLeftWidth: 2,
		borderLeftColor: "hsl(25, 50%, 82%)",
		marginBottom: 8,
	},
	commentText: {
		flex: 1,
		fontSize: 14,
		color: "hsl(30, 15%, 25%)",
		lineHeight: 19,
	},
	commentDate: {
		fontSize: 10,
		color: "#aaa",
		marginLeft: 8,
		marginTop: 2,
	},
	inputContainer: {
		marginTop: 12,
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 8,
	},
	input: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.03)",
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 8,
		fontSize: 14,
		color: "hsl(30, 15%, 15%)",
		maxHeight: 100,
	},
	submitButton: {
		backgroundColor: "hsl(25, 65%, 45%)",
		paddingVertical: 8,
		paddingHorizontal: 14,
		borderRadius: 8,
	},
	submitButtonDisabled: {
		backgroundColor: "rgba(0,0,0,0.05)",
	},
	submitButtonText: {
		color: "white",
		fontSize: 13,
		fontWeight: "600",
	},
	submitButtonTextDisabled: {
		color: "#aaa",
	},
});
