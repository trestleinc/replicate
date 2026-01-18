<script lang="ts">
  import { onMount } from "svelte";
  import { useLiveQuery } from "@tanstack/svelte-db";
  import { comments as commentsLazy } from "$collections/useComments";
  import CommentEditor from "./CommentEditor.svelte";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { getAuthClient } from "$lib/auth-client";

  interface Props {
    intervalId: string;
    isPublic?: boolean;
  }

  let { intervalId, isPublic = true }: Props = $props();

  // Session state - updated from auth client on mount
  let sessionData = $state<{ user?: { id: string } } | null>(null);

  onMount(() => {
    const authClient = getAuthClient();
    const session = authClient.useSession();
    const unsubscribe = session.subscribe((s) => {
      sessionData = s.data;
    });
    return unsubscribe;
  });

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
    const user = sessionData?.user;

    commentsCollection.insert({
      id,
      ownerId: user?.id,
      isPublic,
      intervalId,
      body: newCommentText.trim(),
      createdAt: now,
      updatedAt: now,
    });

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
            <CommentEditor commentId={comment.id} body={comment.body} />
          </div>
          <span class="text-[10px] text-muted-foreground shrink-0 mt-0.5">{formatDate(comment.createdAt)}</span>
        </div>
      {/each}
    </div>
  {/if}

  <form onsubmit={handleSubmit} class="mt-4 flex items-center gap-2">
    <Input
      bind:value={newCommentText}
      placeholder="Add a comment..."
      class="h-7 text-sm"
    />
    <Button type="submit" size="sm" disabled={!newCommentText.trim()}>Post</Button>
  </form>
</div>
