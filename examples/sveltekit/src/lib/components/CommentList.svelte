<script lang="ts">
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

	// Session state - use $effect for subscription (Svelte 5 pattern)
	let sessionData = $state<{ user?: { id: string } } | null>(null);

	// PERFORMANCE FIX: Use $effect with cleanup instead of onMount
	$effect(() => {
		const authClient = getAuthClient();
		const session = authClient.useSession();
		const unsubscribe = session.subscribe((s) => {
			sessionData = s.data;
		});
		return unsubscribe;
	});

	const commentsCollection = commentsLazy.get();
	const commentsQuery = useLiveQuery(commentsCollection);

	// Use $derived.by for complex filtering/sorting
	const filteredComments = $derived.by(() => {
		const data = commentsQuery.data ?? [];
		return data.filter((c) => c.intervalId === intervalId).sort((a, b) => a.createdAt - b.createdAt);
	});

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

<div class="max-w-[720px] mx-auto px-6 pb-12 w-full border-t border-border pt-6 mt-8">
	<h3 class="font-mono text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4">
		Comments
	</h3>

	{#if filteredComments.length === 0}
		<p class="text-sm text-muted-foreground">No comments yet</p>
	{:else}
		<div class="space-y-2">
			{#each filteredComments as comment (comment.id)}
				<div class="flex items-start gap-3 pl-3 border-l-2 border-primary/30">
					<div class="flex-1 min-w-0">
						<CommentEditor commentId={comment.id} body={comment.body} />
					</div>
					<span class="font-mono text-[10px] text-muted-foreground shrink-0 mt-1">
						{formatDate(comment.createdAt)}
					</span>
				</div>
			{/each}
		</div>
	{/if}

	<form onsubmit={handleSubmit} class="mt-4 flex items-center gap-2">
		<Input bind:value={newCommentText} placeholder="Add a comment..." class="h-8 text-sm" />
		<Button type="submit" size="sm" disabled={!newCommentText.trim()}>Post</Button>
	</form>
</div>
