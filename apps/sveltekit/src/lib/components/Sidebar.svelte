<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Globe, Lock } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input';
	import StatusIcon from './StatusIcon.svelte';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import type { Interval } from '$collections/useIntervals';

	interface Props {
		onsearchopen?: () => void;
		onfilteropen?: () => void;
		hasActiveFilters?: boolean;
	}

	// Props defined for future use (onsearchopen, onfilteropen, hasActiveFilters)
	const _props: Props = $props();

	// Get intervals from context (single source of truth)
	const intervalsCtx = getIntervalsContext();

	let editingId = $state<string | null>(null);
	let editTitle = $state('');

	// Sorted intervals using $derived.by for complex computation
	const sortedIntervals = $derived.by(() => {
		const data = intervalsCtx.data;
		return [...data]
			.filter((i): i is Interval => typeof i.id === 'string' && i.id.length > 0)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});

	const activeId = $derived(page.params.id);

	function startRename(id: string) {
		const interval = intervalsCtx.data.find((i) => i.id === id);
		if (interval) {
			editingId = id;
			editTitle = interval.title;
		}
	}

	function saveRename(id: string) {
		if (editTitle.trim()) {
			intervalsCtx.collection.update(id, (draft) => {
				draft.title = editTitle.trim();
				draft.updatedAt = Date.now();
			});
		}
		editingId = null;
	}

	function handleKeydown(e: KeyboardEvent, id: string) {
		if (e.key === 'Enter') saveRename(id);
		if (e.key === 'Escape') editingId = null;
	}
</script>

<aside class="sidebar">
	<div class="sidebar-header">
		<span class="sidebar-title">Intervals</span>
		<span class="text-muted-foreground font-mono text-xs">{sortedIntervals.length}</span>
	</div>

	<div class="sidebar-content">
		{#if intervalsCtx.isLoading}
			<div class="space-y-1 p-2">
				{#each { length: 5 } as _, i (i)}
					<div class="skeleton h-9 w-full"></div>
				{/each}
			</div>
		{:else if sortedIntervals.length === 0}
			<div
				class="text-muted-foreground flex flex-col items-center justify-center px-4 py-12 text-center text-sm"
			>
				<StatusIcon status="backlog" size={24} class="mb-3 opacity-30" />
				<p class="m-0 font-medium">No intervals yet</p>
				<p class="m-0 mt-1 text-xs opacity-60">Press ⌥N to create one</p>
			</div>
		{:else}
			<nav class="p-1">
				<ul class="m-0 list-none p-0">
					{#each sortedIntervals as interval (interval.id)}
						<li>
							{#if editingId === interval.id}
								<div class="bg-muted flex items-center gap-2 px-3 py-2">
									<StatusIcon status={interval.status} size={14} class="shrink-0" />
									<Input
										type="text"
										bind:value={editTitle}
										onblur={() => saveRename(interval.id)}
										onkeydown={(e) => handleKeydown(e, interval.id)}
										class="h-7 flex-1 p-1 text-sm"
									/>
								</div>
							{:else}
								<a
									href={resolve(`/intervals/${interval.id}`)}
									class="sidebar-item {activeId === interval.id ? 'sidebar-item-active' : ''}"
								>
									<StatusIcon status={interval.status} size={14} class="shrink-0" />
									<button
										type="button"
										class="font-inherit min-w-0 flex-1 cursor-pointer overflow-hidden border-none bg-transparent p-0 text-left text-ellipsis whitespace-nowrap text-inherit"
										ondblclick={() => startRename(interval.id)}
									>
										{interval.title || 'Untitled'}
									</button>
									{#if interval.isPublic}
										<Globe class="text-muted-foreground/50 h-3 w-3 shrink-0" />
									{:else}
										<Lock class="text-muted-foreground/50 h-3 w-3 shrink-0" />
									{/if}
								</a>
							{/if}
						</li>
					{/each}
				</ul>
			</nav>
		{/if}
	</div>
</aside>
