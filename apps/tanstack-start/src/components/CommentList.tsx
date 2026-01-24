import { useMemo } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { comments as commentsLazy } from '../collections/useComments';
import { CommentEditor, NewCommentInput } from './CommentEditor';

interface CommentListProps {
	intervalId: string;
}

export function CommentList({ intervalId }: CommentListProps) {
	const commentsCollection = commentsLazy.get();
	const { data: allComments = [], isLoading } = useLiveQuery(commentsCollection);

	const filteredComments = useMemo(() => {
		return allComments
			.filter((c) => c.intervalId === intervalId)
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
		commentsCollection.update(id, (draft) => {
			draft.body = body;
			draft.updatedAt = Date.now();
		});
	};

	return (
		<div className="border-border mx-auto mt-8 w-full max-w-[680px] border-t px-8 pt-6 pb-12">
			<h3 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">
				Comments
			</h3>

			{isLoading ? (
				<p className="text-muted-foreground text-sm">Loading...</p>
			) : filteredComments.length === 0 ? (
				<p className="text-muted-foreground text-sm">No comments yet</p>
			) : (
				<div>
					{filteredComments.map((comment) => (
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
	const date = new Date(comment.createdAt).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
	});

	return (
		<div className="border-primary/20 mb-2 flex items-start gap-2 border-l-2 pl-3">
			<div className="min-w-0 flex-1">
				<CommentEditor commentId={comment.id} body={comment.body} onUpdate={onUpdate} />
			</div>
			<span className="text-muted-foreground mt-0.5 shrink-0 text-[10px]">{date}</span>
		</div>
	);
}
