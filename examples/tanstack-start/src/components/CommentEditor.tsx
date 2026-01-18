import { useState } from "react";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";

interface CommentEditorProps {
	commentId: string;
	body: string;
	onUpdate: (id: string, body: string) => void;
}

export function CommentEditor({ commentId, body, onUpdate }: CommentEditorProps) {
	const [isEditing, setIsEditing] = useState(false);
	const [editedBody, setEditedBody] = useState(body);

	const handleBlur = () => {
		if (editedBody.trim() !== body) {
			onUpdate(commentId, editedBody.trim());
		}
		setIsEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			e.currentTarget.blur();
		}
		if (e.key === "Escape") {
			setEditedBody(body);
			setIsEditing(false);
		}
	};

	if (isEditing) {
		return (
			<Input
				value={editedBody}
				onChange={e => setEditedBody(e.target.value)}
				onBlur={handleBlur}
				onKeyDown={handleKeyDown}
				className="text-sm h-auto py-1"
				autoFocus
			/>
		);
	}

	return (
		<button
			type="button"
			className="text-sm text-left w-full hover:bg-muted/50 rounded px-1 -mx-1 cursor-text"
			onClick={() => setIsEditing(true)}
		>
			{body}
		</button>
	);
}

// Simple text input for creating new comments
interface NewCommentInputProps {
	onSubmit: (text: string) => void;
}

export function NewCommentInput({ onSubmit }: NewCommentInputProps) {
	const [text, setText] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (text.trim()) {
			onSubmit(text.trim());
			setText("");
		}
	};

	return (
		<form onSubmit={handleSubmit} className="mt-4 flex items-end gap-2">
			<Textarea
				value={text}
				onChange={e => setText(e.target.value)}
				placeholder="Add a comment..."
				className="min-h-0 resize-none text-sm"
			/>
			<Button type="submit" size="sm" disabled={!text.trim()}>
				Post
			</Button>
		</form>
	);
}
