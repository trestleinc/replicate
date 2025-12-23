<script lang="ts">
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { getFilterContext } from '$lib/contexts/filters.svelte';
	import IntervalRow from '$lib/components/IntervalRow.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { intervals as intervalsLazy } from '$collections/useIntervals';
	import type { Interval } from '$lib/types';

	const collection = intervalsLazy.get();
	const intervalsQuery = useLiveQuery(collection);
	const filters = getFilterContext();

	const intervals = $derived((intervalsQuery.data ?? []) as Interval[]);

	// Filter and sort intervals
	const filteredIntervals = $derived(() => {
		let result = [...intervals];

		if (filters.statusFilter) {
			result = result.filter((interval) => interval.status === filters.statusFilter);
		}

		if (filters.priorityFilter) {
			result = result.filter((interval) => interval.priority === filters.priorityFilter);
		}

		// Sort by updatedAt descending
		result.sort((a, b) => b.updatedAt - a.updatedAt);

		return result;
	});
</script>

<div class="flex-1 flex flex-col min-h-0">
	{#if intervalsQuery.isLoading}
		<!-- Loading skeleton -->
		<div class="flex flex-col">
			{#each Array(5) as _, i}
				<div class="flex items-center gap-3 px-6 py-3">
					<Skeleton class="w-5 h-5 rounded-full" />
					<Skeleton class="h-4 flex-1" />
					<Skeleton class="h-4 w-16" />
				</div>
			{/each}
		</div>
	{:else if filteredIntervals().length === 0}
		<!-- Empty state -->
		<div class="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
			{#if intervals.length === 0}
				<p class="m-0">No intervals yet</p>
				<p class="text-xs opacity-60 mt-1">
					Press
					<kbd
						class="inline-block px-1.5 py-0.5 mx-0.5 font-mono text-[0.6875rem] bg-background border border-border rounded-sm"
						>&#x2325;</kbd
					>
					<kbd
						class="inline-block px-1.5 py-0.5 mx-0.5 font-mono text-[0.6875rem] bg-background border border-border rounded-sm"
						>N</kbd
					>
					to create your first interval
				</p>
			{:else}
				<p class="m-0">No intervals match your filters</p>
			{/if}
		</div>
	{:else}
		<!-- Interval list -->
		<div class="flex-1 overflow-auto">
			<div class="flex flex-col">
				{#each filteredIntervals() as interval (interval.id)}
					<IntervalRow {interval} />
				{/each}
			</div>
		</div>
	{/if}
</div>
