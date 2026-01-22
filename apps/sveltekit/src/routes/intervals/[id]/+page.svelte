<script module lang="ts">
	import type { Interval } from '$collections/useIntervals';

	// Module-level cache outside of reactive system for better performance
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const intervalCache = new Map<string, Interval>();
</script>

<script lang="ts">
	import { page } from '$app/state';
	import IntervalEditor from '$lib/components/IntervalEditor.svelte';
	import IntervalEditorSkeleton from '$lib/components/IntervalEditorSkeleton.svelte';
	import CommentList from '$lib/components/CommentList.svelte';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';

	// Get data from context (single source of truth)
	const intervalsCtx = getIntervalsContext();
	const id = $derived(page.params.id);

	// PERFORMANCE FIX: Use $derived.by with module-level cache
	// This eliminates the $state + $effect pattern for caching
	const interval = $derived.by(() => {
		// Guard: id should always exist on this route
		if (!id) return null;

		const current = intervalsCtx.data.find((i) => i.id === id);
		if (current) {
			intervalCache.set(id, current);
			return current;
		}
		// Return cached value during transient null states
		return intervalCache.get(id) ?? null;
	});

	// True "not found" only when: not loading and no interval (current or cached)
	const notFound = $derived(!intervalsCtx.isLoading && interval === null);

	function handlePropertyUpdate(updates: Partial<Pick<Interval, 'status' | 'priority'>>) {
		if (interval) {
			intervalsCtx.collection.update(interval.id, (draft) => {
				if (updates.status !== undefined) draft.status = updates.status;
				if (updates.priority !== undefined) draft.priority = updates.priority;
				draft.updatedAt = Date.now();
			});
		}
	}
</script>

{#if intervalsCtx.isLoading && !interval}
	<IntervalEditorSkeleton />
{:else if notFound}
	<div class="flex flex-1 items-center justify-center">
		<div class="text-muted-foreground text-center">
			<p class="font-medium">Interval not found</p>
			<p class="mt-1 text-sm opacity-60">It may have been deleted</p>
		</div>
	</div>
{:else if interval && id}
	<div class="flex-1 overflow-auto">
		{#key id}
			<IntervalEditor intervalId={id} {interval} onPropertyUpdate={handlePropertyUpdate} />
		{/key}
		<CommentList intervalId={id} isPublic={interval.isPublic} />
	</div>
{/if}
