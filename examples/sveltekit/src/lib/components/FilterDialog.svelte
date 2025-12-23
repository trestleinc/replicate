<script lang="ts">
	import { SlidersHorizontal, X } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import StatusIcon from './StatusIcon.svelte';
	import PriorityIcon from './PriorityIcon.svelte';
	import { cn } from '$lib/utils';
	import { Status, Priority, StatusLabels, PriorityLabels } from '$lib/types';
	import type { StatusValue, PriorityValue } from '$lib/types';

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
		onprioritychange
	}: Props = $props();

	let selectedSection = $state<'status' | 'priority'>('status');
	let selectedIndex = $state(0);

	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];

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
		class="w-[85vw] max-w-[85vw] sm:max-w-[400px] h-auto max-h-[80vh] sm:max-h-[85vh] p-0 gap-0 rounded-none"
		onkeydown={handleKeyDown}
	>
		<Dialog.Header class="sr-only">
			<Dialog.Title>Filter intervals</Dialog.Title>
		</Dialog.Header>

		<!-- Header -->
		<div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
			<div class="flex items-center gap-2">
				<SlidersHorizontal class="w-4 h-4 text-muted-foreground shrink-0" />
				<span class="text-sm font-medium">Filters</span>
			</div>
			<div class="flex items-center gap-2">
				{#if hasFilters}
					<Button
						variant="ghost"
						size="sm"
						onclick={handleClearFilters}
						class="text-muted-foreground h-7 px-2"
					>
						Clear all
					</Button>
				{/if}
				<button
					type="button"
					onclick={onclose}
					class="sm:hidden text-sm text-muted-foreground hover:text-foreground"
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
						class="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider"
					>
						Status
					</div>
					<!-- All statuses option -->
					<button
						type="button"
						class={cn(
							'w-full flex items-center gap-3 py-2 px-3 text-left cursor-pointer',
							'transition-colors hover:bg-muted hover:text-foreground border-l-2 border-transparent',
							selectedSection === 'status' &&
								selectedIndex === 0 &&
								'bg-muted text-foreground border-l-2 border-sidebar-accent',
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
								<X class="w-3.5 h-3.5 text-muted-foreground" />
							</span>
						{/if}
					</button>
					{#each statusOptions as status, index}
						<button
							type="button"
							class={cn(
								'w-full flex items-center gap-3 py-2 px-3 text-left cursor-pointer',
								'transition-colors hover:bg-muted hover:text-foreground border-l-2 border-transparent',
								selectedSection === 'status' &&
									selectedIndex === index + 1 &&
									'bg-muted text-foreground border-l-2 border-sidebar-accent',
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
									<X class="w-3.5 h-3.5 text-muted-foreground" />
								</span>
							{/if}
						</button>
					{/each}
				</div>

				<!-- Divider -->
				<div class="h-px bg-border my-2"></div>

				<!-- Priority Section -->
				<div>
					<div
						class="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider"
					>
						Priority
					</div>
					<!-- All priorities option -->
					<button
						type="button"
						class={cn(
							'w-full flex items-center gap-3 py-2 px-3 text-left cursor-pointer',
							'transition-colors hover:bg-muted hover:text-foreground border-l-2 border-transparent',
							selectedSection === 'priority' &&
								selectedIndex === 0 &&
								'bg-muted text-foreground border-l-2 border-sidebar-accent',
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
								<X class="w-3.5 h-3.5 text-muted-foreground" />
							</span>
						{/if}
					</button>
					{#each priorityOptions as priority, index}
						<button
							type="button"
							class={cn(
								'w-full flex items-center gap-3 py-2 px-3 text-left cursor-pointer',
								'transition-colors hover:bg-muted hover:text-foreground border-l-2 border-transparent',
								selectedSection === 'priority' &&
									selectedIndex === index + 1 &&
									'bg-muted text-foreground border-l-2 border-sidebar-accent',
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
									<X class="w-3.5 h-3.5 text-muted-foreground" />
								</span>
							{/if}
						</button>
					{/each}
				</div>
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
					>tab</kbd
				>
				switch section
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
