<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { Plus, Search, SlidersHorizontal } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import StatusIcon from './StatusIcon.svelte';
	import StarIcon from './StarIcon.svelte';
	import { intervals as intervalsCollection } from '$collections/useIntervals';
	import { prose } from '@trestleinc/replicate/client';
	import type { Interval } from '$lib/types';

	type Props = {
		onsearchopen?: () => void;
		onfilteropen?: () => void;
		hasActiveFilters?: boolean;
	};

	const { onsearchopen, onfilteropen, hasActiveFilters = false }: Props = $props();

	const collection = intervalsCollection.get();
	const intervalsQuery = useLiveQuery(collection);

	let editingId = $state<string | null>(null);
	let editTitle = $state('');

	const intervals = $derived((intervalsQuery.data ?? []) as Interval[]);
	const sortedIntervals = $derived(
		[...intervals]
			.filter((i): i is Interval => typeof i.id === 'string' && i.id.length > 0)
			.sort((a, b) => b.updatedAt - a.updatedAt)
	);

	const activeId = $derived(page.params.id);

	function createInterval() {
		const id = crypto.randomUUID();
		const now = Date.now();
		collection.insert({
			id,
			title: 'New Interval',
			description: prose.empty(),
			status: 'backlog',
			priority: 'none',
			createdAt: now,
			updatedAt: now
		});
	}

	function startRename(id: string) {
		const interval = intervals.find((i) => i.id === id);
		if (interval) {
			editingId = id;
			editTitle = interval.title;
		}
	}

	function saveRename(id: string) {
		if (editTitle.trim()) {
			collection.update(id, (draft) => {
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

<aside
	class="hidden md:flex w-[var(--sidebar-width)] min-w-[var(--sidebar-width)] h-dvh flex-col bg-sidebar overflow-hidden"
>
	<!-- Header -->
	<div class="flex items-center justify-between px-3 py-3 border-b border-sidebar-border">
		<a
			href="/intervals"
			class="flex items-center gap-2 font-display text-base font-normal text-sidebar-foreground no-underline"
		>
			<StarIcon size={18} />
			<span>Interval</span>
		</a>
		<div class="flex items-center gap-1">
			<Button variant="ghost" size="icon" onclick={onsearchopen} aria-label="Search intervals">
				<Search class="w-4 h-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				onclick={onfilteropen}
				aria-label="Filter intervals"
				class={hasActiveFilters ? 'text-primary' : ''}
			>
				<SlidersHorizontal class="w-4 h-4" />
			</Button>
		</div>
	</div>

	<!-- New Interval Button -->
	<div class="p-2">
		<Button variant="outline" class="w-full justify-start gap-2" onclick={createInterval}>
			<Plus class="w-4 h-4" />
			<span>New Interval</span>
		</Button>
	</div>

	<!-- Intervals List -->
	<ScrollArea class="flex-1">
		<nav class="p-1">
			{#if intervalsQuery.isLoading}
				<div class="space-y-2 p-2">
					<div class="h-8 w-full bg-muted animate-pulse rounded"></div>
					<div class="h-8 w-3/4 bg-muted animate-pulse rounded"></div>
					<div class="h-8 w-4/5 bg-muted animate-pulse rounded"></div>
				</div>
			{:else if sortedIntervals.length === 0}
				<div
					class="flex flex-col items-center justify-center py-8 px-3 text-muted-foreground text-center text-sm"
				>
					<StatusIcon status="backlog" size={24} class="mb-2 opacity-30" />
					<p class="m-0">No intervals yet</p>
					<p class="m-0 text-xs opacity-60">Create your first interval</p>
				</div>
			{:else}
				<ul class="list-none m-0 p-0 flex flex-col">
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
										class="flex-1 h-6 text-sm p-1"
									/>
								</div>
							{:else}
								<a
									href="/intervals/{interval.id}"
									class="group flex items-center gap-2 px-3 py-2 text-sm no-underline transition-colors {activeId ===
									interval.id
										? 'bg-muted text-foreground border-l-2 border-sidebar-accent'
										: 'text-muted-foreground hover:bg-muted hover:text-foreground border-l-2 border-transparent'}"
								>
									<StatusIcon status={interval.status} size={14} class="shrink-0" />
									<button
										type="button"
										class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left bg-transparent border-none p-0 font-inherit text-inherit cursor-pointer"
										ondblclick={() => startRename(interval.id)}
									>
										{interval.title || 'Untitled'}
									</button>
								</a>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</nav>
	</ScrollArea>
</aside>
