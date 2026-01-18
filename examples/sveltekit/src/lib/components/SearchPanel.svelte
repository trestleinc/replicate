<script lang="ts">
	import { goto } from '$app/navigation';
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { Search, Plus } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import StatusIcon from './StatusIcon.svelte';
	import { cn } from '$lib/utils';
	import { intervals as intervalsCollection, type Interval } from '$collections/useIntervals';
	import { schema } from '@trestleinc/replicate/client';

	type Props = {
		open: boolean;
		onclose: () => void;
	};

	let { open = $bindable(), onclose }: Props = $props();

	const collection = intervalsCollection.get();
	const intervalsQuery = useLiveQuery(collection);

	let query = $state('');
	let selectedIndex = $state(-1);
	let inputRef = $state<HTMLInputElement | null>(null);

	const intervals = $derived((intervalsQuery.data ?? []) as Interval[]);

	const results = $derived(() => {
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
		collection.insert({
			id,
			isPublic: true,
			title: 'New Interval',
			description: schema.prose.empty(),
			status: 'backlog',
			priority: 'none',
			createdAt: now,
			updatedAt: now
		});
		goto(`/intervals/${id}`);
		onclose();
	}

	function handleSelect(id: string) {
		goto(`/intervals/${id}`);
		onclose();
	}

	function handleKeyDown(e: KeyboardEvent) {
		const list = results();
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				selectedIndex = Math.min(selectedIndex + 1, list.length - 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				selectedIndex = Math.max(selectedIndex - 1, -1);
				break;
			case 'Enter':
				e.preventDefault();
				if (selectedIndex === -1) {
					createInterval();
				} else if (list[selectedIndex]) {
					handleSelect(list[selectedIndex].id);
				}
				break;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => !o && onclose()}>
	<Dialog.Content
		class="w-[85vw] max-w-[85vw] sm:max-w-[520px] h-auto max-h-[80vh] sm:max-h-[85vh] p-0 gap-0 rounded-none"
	>
		<Dialog.Header class="sr-only">
			<Dialog.Title>Search intervals</Dialog.Title>
		</Dialog.Header>

		<!-- Search Input -->
		<div class="flex items-center gap-3 px-4 py-3 border-b border-border">
			<Search class="w-4 h-4 text-muted-foreground shrink-0" />
			<Input
				bind:ref={inputRef}
				type="text"
				bind:value={query}
				onkeydown={handleKeyDown}
				placeholder="Search intervals..."
				class="border-0 p-0 h-auto text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
			/>
			<button
				type="button"
				onclick={onclose}
				class="sm:hidden text-sm text-muted-foreground hover:text-foreground"
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
						'w-full flex items-center gap-3 py-2.5 px-3 text-left cursor-pointer',
						'transition-colors hover:bg-muted hover:text-foreground border-l-2 border-transparent',
						selectedIndex === -1 && 'bg-muted text-foreground border-l-2 border-sidebar-accent'
					)}
					onclick={createInterval}
					onmouseenter={() => (selectedIndex = -1)}
				>
					<Plus class="w-4 h-4 shrink-0 text-primary" />
					<span class="text-sm font-medium">New Interval</span>
					<span class="ml-auto text-xs text-muted-foreground">⌥N</span>
				</button>

				<!-- Divider -->
				{#if results().length > 0}
					<div class="h-px bg-border my-1"></div>
				{/if}

				<!-- Interval results -->
				{#if results().length === 0 && query.trim()}
					<div class="py-6 text-center text-muted-foreground text-sm">
						<p>No intervals found for "{query}"</p>
					</div>
				{:else}
					{#each results() as interval, index (interval.id)}
						<button
							type="button"
							class={cn(
								'w-full flex items-center gap-3 py-2.5 px-3 text-left group cursor-pointer',
								'transition-colors hover:bg-muted hover:text-foreground border-l-2 border-transparent',
								index === selectedIndex &&
									'bg-muted text-foreground border-l-2 border-sidebar-accent'
							)}
							onclick={() => handleSelect(interval.id)}
							onmouseenter={() => (selectedIndex = index)}
						>
							<StatusIcon status={interval.status} size={14} class="shrink-0" />
							<div class="flex-1 min-w-0">
								<span class="block text-sm font-medium truncate">
									{interval.title || 'Untitled'}
								</span>
							</div>
						</button>
					{/each}
				{/if}

				<!-- Empty state hint -->
				{#if results().length === 0 && !query.trim()}
					<div class="py-6 text-center text-muted-foreground text-sm">
						<p>No intervals yet</p>
						<p class="mt-1 text-xs">Create your first interval above</p>
					</div>
				{/if}
			</div>
		</ScrollArea>

		<!-- Keyboard hints -->
		<div
			class="hidden sm:flex items-center justify-center gap-4 px-4 py-2 border-t border-border text-xs text-muted-foreground"
		>
			<span>
				<kbd
					class="px-1.5 py-0.5 mx-0.5 font-mono text-[0.6875rem] bg-background border border-border rounded-sm"
					>↑↓</kbd
				>
				navigate
			</span>
			<span>
				<kbd
					class="px-1.5 py-0.5 mx-0.5 font-mono text-[0.6875rem] bg-background border border-border rounded-sm"
					>↵</kbd
				>
				select
			</span>
			<span>
				<kbd
					class="px-1.5 py-0.5 mx-0.5 font-mono text-[0.6875rem] bg-background border border-border rounded-sm"
					>esc</kbd
				>
				close
			</span>
		</div>
	</Dialog.Content>
</Dialog.Root>
