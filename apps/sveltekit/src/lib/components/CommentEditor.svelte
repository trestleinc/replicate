<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { comments } from '$collections/useComments';

	interface Props {
		commentId: string;
		body: string;
	}

	let { commentId, body }: Props = $props();

	const collection = comments.get();

	let isEditing = $state(false);
	let editedBody = $state('');

	$effect(() => {
		if (!isEditing) {
			editedBody = body;
		}
	});

	function handleBlur() {
		if (editedBody.trim() !== body) {
			collection.update(commentId, (draft) => {
				draft.body = editedBody.trim();
				draft.updatedAt = Date.now();
			});
		}
		isEditing = false;
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			(e.target as HTMLInputElement).blur();
		}
		if (e.key === 'Escape') {
			editedBody = body;
			isEditing = false;
		}
	}
</script>

{#if isEditing}
	<Input
		bind:value={editedBody}
		onblur={handleBlur}
		onkeydown={handleKeyDown}
		class="h-auto py-1 text-sm"
	/>
{:else}
	<button
		type="button"
		class="hover:bg-muted/50 -mx-1 w-full cursor-text rounded px-1 text-left text-sm"
		onclick={() => (isEditing = true)}
	>
		{body}
	</button>
{/if}
