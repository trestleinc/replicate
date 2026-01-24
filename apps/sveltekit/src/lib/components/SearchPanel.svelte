<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Search, Plus } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import StatusIcon from './StatusIcon.svelte';
	import { cn } from '$lib/utils';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import { schema } from '@trestleinc/replicate/client';

	type Props = {
		open: boolean;
		onclose: () => void;
	};

	let { open = $bindable(), onclose }: Props = $props();

	// Get data from context (single source of truth)
	const intervalsCtx = getIntervalsContext();

	let query = $state('');
	let selectedIndex = $state(-1);
	let inputRef = $state<HTMLInputElement | null>(null);

	// PERFORMANCE FIX: Use $derived.by directly, not $derived returning a function
	const results = $derived.by(() => {
		const intervals = intervalsCtx.data;
		const sorted = [...intervals].sort((a, b) => b.updatedAt - a.updatedAt);
		if (!query.trim()) {
			return sorted.slice(0, 10);
		}
		const q = query.toLowerCase();
		return sorted.filter((i) => i.title?.toLowerCase().includes(q)).slice(0, 20);
	});

	$effect(() => {
		if (open) {
			query = '';
			selectedIndex = -1;
			setTimeout(() => inputRef?.focus(), 50);
		}
	});

	function createInterval() {
		const id = crypto.randomUUID();
		const now = Date.now();
		intervalsCtx.collection.insert({
			id,
			isPublic: true,
			title: 'New Interval',
			description: schema.prose.empty(),
			status: 'backlog',
			priority: 'none',
			createdAt: now,
			updatedAt: now,
		});
		goto(resolve(`/intervals/${id}`));
		onclose();
	}

	function handleSelect(id: string) {
		goto(resolve(`/intervals/${id}`));
		onclose();
	}

	function handleKeyDown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				selectedIndex = Math.max(selectedIndex - 1, -1);
				break;
			case 'Enter':
				e.preventDefault();
				if (selectedIndex === -1) {
					createInterval();
				} else if (results[selectedIndex]) {
					handleSelect(results[selectedIndex].id);
				}
				break;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => !o && onclose()}>
	<Dialog.Content
		class="h-auto max-h-[80vh] w-[85vw] max-w-[85vw] gap-0 p-0 sm:max-h-[85vh] sm:max-w-[520px]"
	>
		<Dialog.Header class="sr-only">
			<Dialog.Title>Search intervals</Dialog.Title>
		</Dialog.Header>

		<!-- Search Input -->
		<div class="border-border flex items-center gap-3 border-b px-4 py-3">
			<Search class="text-muted-foreground h-4 w-4 shrink-0" />
			<Input
				bind:ref={inputRef}
				type="text"
				bind:value={query}
				onkeydown={handleKeyDown}
				placeholder="Search intervals..."
				class="h-auto border-0 p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
			/>
			<button
				type="button"
				onclick={onclose}
				class="text-muted-foreground hover:text-foreground transition-fast text-sm sm:hidden"
			>
				Cancel
			</button>
		</div>

		<!-- Results -->
		<ScrollArea class="flex-1 sm:max-h-[400px]">
			<div class="p-1">
				<!-- New Interval action -->
				<button
					type="button"
					class={cn(
						'flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left',
						'transition-fast hover:bg-muted hover:text-foreground border-l-2 border-transparent',
						selectedIndex === -1 && 'bg-muted text-foreground border-primary'
					)}
					onclick={createInterval}
					onmouseenter={() => (selectedIndex = -1)}
				>
					<Plus class="text-primary h-4 w-4 shrink-0" />
					<span class="text-sm font-medium">New Interval</span>
					<span class="text-muted-foreground ml-auto font-mono text-xs">⌥N</span>
				</button>

				<!-- Divider -->
				{#if results.length > 0}
					<div class="bg-border my-1 h-px"></div>
				{/if}

				<!-- Interval results -->
				{#if results.length === 0 && query.trim()}
					<div class="text-muted-foreground py-6 text-center text-sm">
						<p>No intervals found for "{query}"</p>
					</div>
				{:else}
					{#each results as interval, index (interval.id)}
						<button
							type="button"
							class={cn(
								'group flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left',
								'transition-fast hover:bg-muted hover:text-foreground border-l-2 border-transparent',
								index === selectedIndex && 'bg-muted text-foreground border-primary'
							)}
							onclick={() => handleSelect(interval.id)}
							onmouseenter={() => (selectedIndex = index)}
						>
							<StatusIcon status={interval.status} size={14} class="shrink-0" />
							<div class="min-w-0 flex-1">
								<span class="block truncate text-sm font-medium">
									{interval.title || 'Untitled'}
								</span>
							</div>
						</button>
					{/each}
				{/if}

				<!-- Empty state hint -->
				{#if results.length === 0 && !query.trim()}
					<div class="text-muted-foreground py-6 text-center text-sm">
						<p>No intervals yet</p>
						<p class="mt-1 text-xs">Create your first interval above</p>
					</div>
				{/if}
			</div>
		</ScrollArea>

		<!-- Keyboard hints -->
		<div
			class="border-border text-muted-foreground hidden items-center justify-center gap-4 border-t px-4 py-2 text-xs sm:flex"
		>
			<span>
				<kbd class="kbd-key">↑↓</kbd>
				navigate
			</span>
			<span>
				<kbd class="kbd-key">↵</kbd>
				select
			</span>
			<span>
				<kbd class="kbd-key">esc</kbd>
				close
			</span>
		</div>
	</Dialog.Content>
</Dialog.Root>
