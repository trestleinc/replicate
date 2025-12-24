<script lang="ts">
  import { useLiveQuery } from "@tanstack/svelte-db";
  import { comments as commentsLazy } from "$collections/useComments";
  import CommentEditor from "./CommentEditor.svelte";
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
    });
  }
</script>

<div class="max-w-[680px] mx-auto px-8 pb-12 w-full border-t border-border pt-6 mt-8">
  <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Comments</h3>

  {#if filteredComments.length === 0}
    <p class="text-sm text-muted-foreground">No comments yet</p>
  {:else}
    <div>
      {#each filteredComments as comment (comment.id)}
        <div class="flex items-start gap-2 pl-3 border-l-2 border-primary/20 mb-2">
          <div class="flex-1 min-w-0">
            <CommentEditor commentId={comment.id} />
          </div>
          <span class="text-[10px] text-muted-foreground shrink-0 mt-0.5">{formatDate(comment.createdAt)}</span>
        </div>
      {/each}
    </div>
  {/if}

  <form onsubmit={handleSubmit} class="mt-4 flex items-end gap-2">
    <Textarea
      bind:value={newCommentText}
      placeholder="Add a comment..."
      class="min-h-0 resize-none text-sm"
    />
    <Button type="submit" size="sm" disabled={!newCommentText.trim()}>Post</Button>
  </form>
</div>
