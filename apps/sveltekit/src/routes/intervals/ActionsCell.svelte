<script lang="ts">
	import { MoreHorizontal, Trash2, Globe, Lock } from '@lucide/svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import { getAuthClient } from '$lib/auth-client';
	import type { Interval } from '$collections/useIntervals';

	type Props = { interval: Interval };
	const { interval }: Props = $props();

	// Get collection from context for mutations
	const intervalsCtx = getIntervalsContext();
	let showDeleteConfirm = $state(false);

	// Auth state for ownership check
	let sessionData = $state<{ user?: { id: string } } | null>(null);

	$effect(() => {
		const authClient = getAuthClient();
		const session = authClient.useSession();
		const unsubscribe = session.subscribe((s) => {
			sessionData = s.data;
		});
		return unsubscribe;
	});

	// Check if current user owns this interval
	const isOwner = $derived(
		sessionData?.user?.id != null && sessionData.user.id === interval.ownerId
	);

	function handleDeleteClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		showDeleteConfirm = true;
	}

	function handleConfirmDelete() {
		intervalsCtx.collection.delete(interval.id);
		showDeleteConfirm = false;
	}

	function toggleVisibility() {
		intervalsCtx.collection.update(interval.id, (draft) => {
			draft.isPublic = !draft.isPublic;
			draft.updatedAt = Date.now();
		});
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="text-muted-foreground hover:text-foreground hover:bg-muted transition-fast flex h-6 w-6 items-center justify-center rounded opacity-0 group-hover:opacity-100"
		title="More actions"
		onclick={(e: MouseEvent) => e.stopPropagation()}
	>
		<MoreHorizontal class="h-3.5 w-3.5" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-40">
		{#if isOwner}
			<DropdownMenu.Item onclick={toggleVisibility}>
				{#if interval.isPublic}
					<Lock class="mr-2 h-4 w-4" />
					<span>Make Private</span>
				{:else}
					<Globe class="mr-2 h-4 w-4" />
					<span>Make Public</span>
				{/if}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
		{/if}
		<DropdownMenu.Item onclick={handleDeleteClick} class="text-destructive focus:text-destructive">
			<Trash2 class="mr-2 h-4 w-4" />
			<span>Delete</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<AlertDialog.Root bind:open={showDeleteConfirm}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete interval?</AlertDialog.Title>
			<AlertDialog.Description>
				"{interval.title || 'Untitled'}" will be permanently deleted. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={handleConfirmDelete}
				class="border-destructive text-destructive hover:bg-destructive/10 border bg-transparent"
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
