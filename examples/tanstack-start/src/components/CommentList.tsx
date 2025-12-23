import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { comments as commentsLazy } from "../collections/useComments";
import { CommentEditor, NewCommentInput } from "./CommentEditor";
import { Card, CardHeader, CardContent } from "./ui/card";
import type { Comment } from "../types/interval";

interface CommentListProps {
  intervalId: string;
}

export function CommentList({ intervalId }: CommentListProps) {
  const commentsCollection = commentsLazy.get();
  const { data: allComments = [], isLoading } = useLiveQuery(commentsCollection);

  const filteredComments = useMemo(() => {
    return (allComments as Comment[])
      .filter(c => c.intervalId === intervalId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [allComments, intervalId]);

  const handleNewComment = (text: string) => {
    const id = crypto.randomUUID();
    const now = Date.now();

    commentsCollection.insert({
      id,
      intervalId,
      body: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      createdAt: now,
      updatedAt: now,
    } as Comment);
  };

  return (
    <div className="max-w-[680px] mx-auto px-8 pb-12 w-full border-t border-border pt-8 mt-8">
      <h3 className="font-display text-lg font-normal mb-4">Comments</h3>

      {isLoading
        ? (
            <p className="text-sm text-muted-foreground py-4">Loading comments...</p>
          )
        : filteredComments.length === 0
          ? (
              <p className="text-sm text-muted-foreground py-4">No comments yet</p>
            )
          : (
              <div className="space-y-4">
                {filteredComments.map(comment => (
                  <CommentItem key={comment.id} comment={comment} collection={commentsCollection} />
                ))}
              </div>
            )}

      <NewCommentInput onSubmit={handleNewComment} />
    </div>
  );
}

interface CommentItemProps {
  comment: Comment;
  collection: ReturnType<typeof commentsLazy.get>;
}

function CommentItem({ comment, collection }: CommentItemProps) {
  const date = new Date(comment.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <Card size="sm">
      <CardHeader className="py-2 bg-muted/30 border-b border-border">
        <span className="text-xs text-muted-foreground">{date}</span>
      </CardHeader>
      <CardContent>
        <CommentEditor commentId={comment.id} collection={collection} />
      </CardContent>
    </Card>
  );
}
