<script lang="ts">
  import { useLiveQuery } from "@tanstack/svelte-db";
  import { comments as commentsLazy } from "$collections/useComments";
  import CommentEditor from "./CommentEditor.svelte";
  import { Card, CardHeader, CardContent } from "$lib/components/ui/card";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Button } from "$lib/components/ui/button";
  import type { Comment } from "$lib/types";

  interface Props {
    intervalId: string;
  }

  let { intervalId }: Props = $props();

  const commentsCollection = commentsLazy.get();
  const commentsQuery = useLiveQuery(commentsCollection);

  const filteredComments = $derived(
    ((commentsQuery.data ?? []))
      .filter(c => c.intervalId === intervalId)
      .sort((a, b) => a.createdAt - b.createdAt),
  );

  let newCommentText = $state("");

  function handleNewComment() {
    if (!newCommentText.trim()) return;

    const id = crypto.randomUUID();
    const now = Date.now();

    commentsCollection.insert({
      id,
      intervalId,
      body: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: newCommentText.trim() }] }],
      },
      createdAt: now,
      updatedAt: now,
    } as Comment);

    newCommentText = "";
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    handleNewComment();
  }

  function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
</script>

<div class="max-w-[680px] mx-auto px-8 pb-12 w-full border-t border-border pt-8 mt-8">
  <h3 class="font-display text-lg font-normal mb-4">Comments</h3>

  {#if filteredComments.length === 0}
    <p class="text-sm text-muted-foreground py-4">No comments yet</p>
  {:else}
    <div class="space-y-4">
      {#each filteredComments as comment (comment.id)}
        <Card size="sm">
          <CardHeader class="py-2 bg-muted/30 border-b border-border">
            <span class="text-xs text-muted-foreground">{formatDate(comment.createdAt)}</span>
          </CardHeader>
          <CardContent>
            <CommentEditor commentId={comment.id} />
          </CardContent>
        </Card>
      {/each}
    </div>
  {/if}

  <form onsubmit={handleSubmit} class="mt-6 space-y-3">
    <Textarea bind:value={newCommentText} placeholder="Write a comment..." rows={3} />
    <Button type="submit" disabled={!newCommentText.trim()}>Comment</Button>
  </form>
</div>
