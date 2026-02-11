<script module lang="ts">
	import { Status, Priority, StatusLabels, PriorityLabels } from '$lib/types';
	import type { StatusValue, PriorityValue } from '$lib/types';

	// PERFORMANCE: Static arrays at module scope - shared across all instances
	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];
</script>

<script lang="ts">
	import { SlidersHorizontal, X } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import StatusIcon from './StatusIcon.svelte';
	import PriorityIcon from './PriorityIcon.svelte';
	import { cn } from '$lib/utils';

	type Props = {
		open: boolean;
		onclose: () => void;
		statusFilter: StatusValue | null;
		priorityFilter: PriorityValue | null;
		onstatuschange: (status: StatusValue | null) => void;
		onprioritychange: (priority: PriorityValue | null) => void;
	};

	let {
		open = $bindable(),
		onclose,
		statusFilter,
		priorityFilter,
		onstatuschange,
		onprioritychange,
	}: Props = $props();

	let selectedSection = $state<'status' | 'priority'>('status');
	let selectedIndex = $state(0);

	const hasFilters = $derived(statusFilter !== null || priorityFilter !== null);

	$effect(() => {
		if (open) {
			selectedSection = 'status';
			selectedIndex = 0;
		}
	});

	function handleClearFilters() {
		onstatuschange(null);
		onprioritychange(null);
	}

	function handleKeyDown(e: KeyboardEvent) {
		const currentOptions = selectedSection === 'status' ? statusOptions : priorityOptions;
		const optionsCount = currentOptions.length + 1;

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				selectedIndex = Math.min(selectedIndex + 1, optionsCount - 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				selectedIndex = Math.max(selectedIndex - 1, 0);
				break;
			case 'Tab':
				e.preventDefault();
				selectedSection = selectedSection === 'status' ? 'priority' : 'status';
				selectedIndex = 0;
				break;
			case 'Enter':
				e.preventDefault();
				if (selectedSection === 'status') {
					if (selectedIndex === 0) {
						onstatuschange(null);
					} else {
						onstatuschange(statusOptions[selectedIndex - 1]);
					}
				} else {
					if (selectedIndex === 0) {
						onprioritychange(null);
					} else {
						onprioritychange(priorityOptions[selectedIndex - 1]);
					}
				}
				break;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => !o && onclose()}>
	<Dialog.Content
		class="h-auto max-h-[80vh] w-[85vw] max-w-[85vw] gap-0 p-0 sm:max-h-[85vh] sm:max-w-[400px]"
		onkeydown={handleKeyDown}
		showCloseButton={false}
	>
		<Dialog.Header class="sr-only">
			<Dialog.Title>Filter intervals</Dialog.Title>
		</Dialog.Header>

		<!-- Header -->
		<div class="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
			<div class="flex items-center gap-2">
				<SlidersHorizontal class="text-muted-foreground h-4 w-4 shrink-0" />
				<span class="text-sm font-medium">Filters</span>
			</div>
			<div class="flex items-center gap-2">
				{#if hasFilters}
					<Button
						variant="ghost"
						size="xs"
						onclick={handleClearFilters}
						class="text-muted-foreground"
					>
						Clear all
					</Button>
				{/if}
				<button
					type="button"
					onclick={onclose}
					class="text-muted-foreground hover:text-foreground transition-fast text-sm sm:hidden"
				>
					Done
				</button>
			</div>
		</div>

		<!-- Filter Sections -->
		<ScrollArea class="flex-1 sm:max-h-[400px]">
			<div class="p-1">
				<!-- Status Section -->
				<div class="mb-2">
					<div
						class="text-muted-foreground px-3 py-1.5 font-mono text-xs font-medium tracking-wider uppercase"
					>
						Status
					</div>
					<!-- All statuses option -->
					<button
						type="button"
						class={cn(
							'flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left',
							'transition-fast hover:bg-muted hover:text-foreground border-l-2 border-transparent',
							selectedSection === 'status' &&
								selectedIndex === 0 &&
								'bg-muted text-foreground border-primary',
							statusFilter === null &&
								!(selectedSection === 'status' && selectedIndex === 0) &&
								'text-primary'
						)}
						onclick={() => onstatuschange(null)}
						onmouseenter={() => {
							selectedSection = 'status';
							selectedIndex = 0;
						}}
					>
						<span class="text-sm">All statuses</span>
						{#if statusFilter === null}
							<span class="ml-auto">
								<X class="text-muted-foreground h-3.5 w-3.5" />
							</span>
						{/if}
					</button>
					{#each statusOptions as status, index (status)}
						<button
							type="button"
							class={cn(
								'flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left',
								'transition-fast hover:bg-muted hover:text-foreground border-l-2 border-transparent',
								selectedSection === 'status' &&
									selectedIndex === index + 1 &&
									'bg-muted text-foreground border-primary',
								statusFilter === status &&
									!(selectedSection === 'status' && selectedIndex === index + 1) &&
									'text-primary'
							)}
							onclick={() => onstatuschange(status)}
							onmouseenter={() => {
								selectedSection = 'status';
								selectedIndex = index + 1;
							}}
						>
							<StatusIcon {status} size={14} class="shrink-0" />
							<span class="text-sm">{StatusLabels[status]}</span>
							{#if statusFilter === status}
								<span class="ml-auto">
									<X class="text-muted-foreground h-3.5 w-3.5" />
								</span>
							{/if}
						</button>
					{/each}
				</div>

				<!-- Divider -->
				<div class="bg-border my-2 h-px"></div>

				<!-- Priority Section -->
				<div>
					<div
						class="text-muted-foreground px-3 py-1.5 font-mono text-xs font-medium tracking-wider uppercase"
					>
						Priority
					</div>
					<!-- All priorities option -->
					<button
						type="button"
						class={cn(
							'flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left',
							'transition-fast hover:bg-muted hover:text-foreground border-l-2 border-transparent',
							selectedSection === 'priority' &&
								selectedIndex === 0 &&
								'bg-muted text-foreground border-primary',
							priorityFilter === null &&
								!(selectedSection === 'priority' && selectedIndex === 0) &&
								'text-primary'
						)}
						onclick={() => onprioritychange(null)}
						onmouseenter={() => {
							selectedSection = 'priority';
							selectedIndex = 0;
						}}
					>
						<span class="text-sm">All priorities</span>
						{#if priorityFilter === null}
							<span class="ml-auto">
								<X class="text-muted-foreground h-3.5 w-3.5" />
							</span>
						{/if}
					</button>
					{#each priorityOptions as priority, index (priority)}
						<button
							type="button"
							class={cn(
								'flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left',
								'transition-fast hover:bg-muted hover:text-foreground border-l-2 border-transparent',
								selectedSection === 'priority' &&
									selectedIndex === index + 1 &&
									'bg-muted text-foreground border-primary',
								priorityFilter === priority &&
									!(selectedSection === 'priority' && selectedIndex === index + 1) &&
									'text-primary'
							)}
							onclick={() => onprioritychange(priority)}
							onmouseenter={() => {
								selectedSection = 'priority';
								selectedIndex = index + 1;
							}}
						>
							<PriorityIcon {priority} size={14} class="shrink-0" />
							<span class="text-sm">{PriorityLabels[priority]}</span>
							{#if priorityFilter === priority}
								<span class="ml-auto">
									<X class="text-muted-foreground h-3.5 w-3.5" />
								</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>
		</ScrollArea>

		<!-- Keyboard hints -->
		<div
			class="border-border text-muted-foreground hidden items-center justify-center gap-4 border-t px-4 py-2 text-xs sm:flex"
		>
			<span><kbd class="kbd-key">↑↓</kbd> navigate</span>
			<span><kbd class="kbd-key">tab</kbd> switch</span>
			<span><kbd class="kbd-key">esc</kbd> close</span>
		</div>
	</Dialog.Content>
</Dialog.Root>
