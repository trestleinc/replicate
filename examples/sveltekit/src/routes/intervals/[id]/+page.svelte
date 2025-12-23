<script lang="ts">
	import { page } from '$app/state';
	import { useLiveQuery } from '@tanstack/svelte-db';
	import StatusIcon from '$lib/components/StatusIcon.svelte';
	import PriorityIcon from '$lib/components/PriorityIcon.svelte';
	import IntervalProperties from '$lib/components/IntervalProperties.svelte';
	import IntervalEditor from '$lib/components/IntervalEditor.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Status, Priority, StatusLabels, PriorityLabels } from '$lib/types';
	import type { Interval, StatusValue, PriorityValue } from '$lib/types';
	import { intervals } from '$collections/useIntervals';

	const collection = intervals.get();
	const id = $derived(page.params.id);

	const intervalsQuery = useLiveQuery(collection);

	const interval = $derived(
		((intervalsQuery.data ?? []) as Interval[]).find((i) => i.id === id) ?? null
	);

	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];

	function handleStatusChange(newStatus: string) {
		if (interval) {
			collection.update(interval.id, (draft) => {
				draft.status = newStatus as StatusValue;
				draft.updatedAt = Date.now();
			});
		}
	}

	function handlePriorityChange(newPriority: string) {
		if (interval) {
			collection.update(interval.id, (draft) => {
				draft.priority = newPriority as PriorityValue;
				draft.updatedAt = Date.now();
			});
		}
	}
</script>

{#if intervalsQuery.isLoading}
	<div class="flex-1 flex items-center justify-center">
		<div class="editor-loading" aria-live="polite" aria-busy="true">
			<div class="editor-loading-spinner"></div>
			<p>Loading...</p>
		</div>
	</div>
{:else if !interval}
	<div class="flex-1 flex items-center justify-center">
		<div class="text-center text-muted-foreground">
			<p>Interval not found</p>
		</div>
	</div>
{:else}
	<div class="flex-1 flex overflow-hidden">
		<!-- Main content -->
		<div class="flex-1 overflow-auto">
			<!-- Mobile properties row -->
			<div class="flex items-center gap-2 px-4 py-3 border-b border-border lg:hidden">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-muted transition-colors"
					>
						<StatusIcon status={interval.status} size={14} />
						<span>{StatusLabels[interval.status]}</span>
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start">
						<DropdownMenu.RadioGroup
							value={interval.status}
							onValueChange={handleStatusChange}
						>
							{#each statusOptions as status}
								<DropdownMenu.RadioItem value={status}>
									<StatusIcon {status} size={14} />
									<span class="ml-2">{StatusLabels[status]}</span>
								</DropdownMenu.RadioItem>
							{/each}
						</DropdownMenu.RadioGroup>
					</DropdownMenu.Content>
				</DropdownMenu.Root>

				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-muted transition-colors"
					>
						<PriorityIcon priority={interval.priority} size={14} />
						<span>{PriorityLabels[interval.priority]}</span>
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start">
						<DropdownMenu.RadioGroup
							value={interval.priority}
							onValueChange={handlePriorityChange}
						>
							{#each priorityOptions as priority}
								<DropdownMenu.RadioItem value={priority}>
									<PriorityIcon {priority} size={14} />
									<span class="ml-2">{PriorityLabels[priority]}</span>
								</DropdownMenu.RadioItem>
							{/each}
						</DropdownMenu.RadioGroup>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>

			<!-- TipTap Editor -->
			{#if id}
				{#key id}
					<IntervalEditor intervalId={id} {interval} />
				{/key}
			{/if}
		</div>

		<!-- Sidebar - hidden on mobile -->
		<aside class="hidden lg:block w-64 shrink-0 border-l border-border overflow-auto bg-card">
			<IntervalProperties {interval} />
		</aside>
	</div>
{/if}
