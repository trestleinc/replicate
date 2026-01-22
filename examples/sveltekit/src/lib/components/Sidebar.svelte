<script lang="ts">
	import { page } from "$app/state";
	import { Globe, Lock } from "@lucide/svelte";
	import { Input } from "$lib/components/ui/input";
	import StatusIcon from "./StatusIcon.svelte";
	import { getIntervalsContext } from "$lib/contexts/intervals.svelte";
	import type { Interval } from "$collections/useIntervals";

	interface Props {
		onsearchopen?: () => void;
		onfilteropen?: () => void;
		hasActiveFilters?: boolean;
	}

	const { onsearchopen, onfilteropen, hasActiveFilters = false }: Props = $props();

	// Get intervals from context (single source of truth)
	const intervalsCtx = getIntervalsContext();

	let editingId = $state<string | null>(null);
	let editTitle = $state("");

	// Sorted intervals using $derived.by for complex computation
	const sortedIntervals = $derived.by(() => {
		const data = intervalsCtx.data;
		return [...data]
			.filter((i): i is Interval => typeof i.id === "string" && i.id.length > 0)
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
		if (e.key === "Enter") saveRename(id);
		if (e.key === "Escape") editingId = null;
	}
</script>

<aside class="sidebar">
	<div class="sidebar-header">
		<span class="sidebar-title">Intervals</span>
		<span class="font-mono text-xs text-muted-foreground">{sortedIntervals.length}</span>
	</div>

	<div class="sidebar-content">
		{#if intervalsCtx.isLoading}
			<div class="space-y-1 p-2">
				{#each Array(5) as _}
					<div class="h-9 w-full skeleton"></div>
				{/each}
			</div>
		{:else if sortedIntervals.length === 0}
			<div
				class="flex flex-col items-center justify-center py-12 px-4 text-muted-foreground text-center text-sm"
			>
				<StatusIcon status="backlog" size={24} class="mb-3 opacity-30" />
				<p class="m-0 font-medium">No intervals yet</p>
				<p class="m-0 text-xs opacity-60 mt-1">Press ⌥N to create one</p>
			</div>
		{:else}
			<nav class="p-1">
				<ul class="list-none m-0 p-0">
					{#each sortedIntervals as interval (interval.id)}
						<li>
							{#if editingId === interval.id}
								<div class="flex items-center gap-2 px-3 py-2 bg-muted">
									<StatusIcon status={interval.status} size={14} class="shrink-0" />
									<Input
										type="text"
										bind:value={editTitle}
										onblur={() => saveRename(interval.id)}
										onkeydown={(e) => handleKeydown(e, interval.id)}
										class="flex-1 h-7 text-sm p-1"
									/>
								</div>
							{:else}
								<a
									href="/intervals/{interval.id}"
									class="sidebar-item {activeId === interval.id ? 'sidebar-item-active' : ''}"
								>
									<StatusIcon status={interval.status} size={14} class="shrink-0" />
									<button
										type="button"
										class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left bg-transparent border-none p-0 font-inherit text-inherit cursor-pointer"
										ondblclick={() => startRename(interval.id)}
									>
										{interval.title || "Untitled"}
									</button>
									{#if interval.isPublic}
										<Globe class="w-3 h-3 text-muted-foreground/50 shrink-0" />
									{:else}
										<Lock class="w-3 h-3 text-muted-foreground/50 shrink-0" />
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
