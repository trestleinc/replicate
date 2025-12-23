<script lang="ts">
	import { Status, Priority, StatusLabels, PriorityLabels } from '$lib/types';
	import type { Interval, StatusValue, PriorityValue } from '$lib/types';
	import StatusIcon from './StatusIcon.svelte';
	import PriorityIcon from './PriorityIcon.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { intervals } from '$collections/useIntervals';

	type Props = {
		interval: Interval;
	};

	const { interval }: Props = $props();
	const collection = intervals.get();

	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];

	const createdDate = $derived(
		new Date(interval.createdAt).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		})
	);

	function handleStatusChange(newStatus: string) {
		collection.update(interval.id, (draft) => {
			draft.status = newStatus as StatusValue;
			draft.updatedAt = Date.now();
		});
	}

	function handlePriorityChange(newPriority: string) {
		collection.update(interval.id, (draft) => {
			draft.priority = newPriority as PriorityValue;
			draft.updatedAt = Date.now();
		});
	}
</script>

<div class="p-4 space-y-4">
	<h3 class="font-display text-sm font-normal text-muted-foreground uppercase tracking-wide">
		Properties
	</h3>

	<!-- Status property -->
	<div class="space-y-1">
		<span class="text-xs text-muted-foreground">Status</span>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-left rounded-sm hover:bg-muted transition-colors"
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
	</div>

	<!-- Priority property -->
	<div class="space-y-1">
		<span class="text-xs text-muted-foreground">Priority</span>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-left rounded-sm hover:bg-muted transition-colors"
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

	<!-- Created date -->
	<div class="space-y-1">
		<span class="text-xs text-muted-foreground">Created</span>
		<span class="block text-sm text-foreground">{createdDate}</span>
	</div>
</div>
