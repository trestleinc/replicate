import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { comments as commentsLazy } from "../collections/useComments";
import { CommentEditor, NewCommentInput } from "./CommentEditor";

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
		const id = crypto.randomUUID();
		const now = Date.now();

		commentsCollection.insert({
			id,
			intervalId,
			body: text,
			createdAt: now,
			updatedAt: now,
		});
	};

	const handleUpdateComment = (id: string, body: string) => {
		commentsCollection.update(id, draft => {
			draft.body = body;
			draft.updatedAt = Date.now();
		});
	};

	return (
		<div className="max-w-[680px] mx-auto px-8 pb-12 w-full border-t border-border pt-6 mt-8">
			<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
				Comments
			</h3>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : filteredComments.length === 0 ? (
				<p className="text-sm text-muted-foreground">No comments yet</p>
			) : (
				<div>
					{filteredComments.map(comment => (
						<CommentItem key={comment.id} comment={comment} onUpdate={handleUpdateComment} />
					))}
				</div>
			)}

			<NewCommentInput onSubmit={handleNewComment} />
		</div>
	);
}

interface CommentItemProps {
	comment: { id: string; body: string; createdAt: number };
	onUpdate: (id: string, body: string) => void;
}

function CommentItem({ comment, onUpdate }: CommentItemProps) {
	const date = new Date(comment.createdAt).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});

	return (
		<div className="flex items-start gap-2 pl-3 border-l-2 border-primary/20 mb-2">
			<div className="flex-1 min-w-0">
				<CommentEditor commentId={comment.id} body={comment.body} onUpdate={onUpdate} />
			</div>
			<span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">{date}</span>
		</div>
	);
}
