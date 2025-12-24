<script lang="ts">
	import { goto } from '$app/navigation';
	import { Trash2 } from '@lucide/svelte';
	import StatusIcon from './StatusIcon.svelte';
	import PriorityIcon from './PriorityIcon.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Status, Priority, StatusLabels, PriorityLabels } from '$lib/types';
	import type { Interval, StatusValue, PriorityValue } from '$lib/types';
	import { intervals } from '$collections/useIntervals';

	type Props = {
		interval: Interval;
	};

	const { interval }: Props = $props();
	const collection = intervals.get();

	let showDeleteConfirm = $state(false);

	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];

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

	function handleDeleteClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		showDeleteConfirm = true;
	}

	function handleConfirmDelete() {
		collection.delete(interval.id);
		showDeleteConfirm = false;
	}

	function handleRowClick() {
		goto(`/intervals/${interval.id}`);
	}
</script>

<div
	class="group flex items-center gap-3 px-6 py-3 border-b border-border transition-colors hover:bg-muted"
>
	<!-- Status dropdown -->
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class="flex items-center rounded-sm hover:bg-muted transition-colors shrink-0"
		>
			<StatusIcon status={interval.status} size={14} />
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start">
			<DropdownMenu.RadioGroup value={interval.status} onValueChange={handleStatusChange}>
				{#each statusOptions as status}
					<DropdownMenu.RadioItem value={status}>
						<StatusIcon {status} size={14} />
						<span class="ml-2">{StatusLabels[status]}</span>
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<!-- Title - clickable link -->
	<button
		type="button"
		onclick={handleRowClick}
		class="flex-1 min-w-0 text-left cursor-pointer bg-transparent border-none p-0"
	>
		<span class="text-sm font-medium truncate">{interval.title || 'Untitled'}</span>
	</button>

	<!-- Priority dropdown -->
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class="flex items-center rounded-sm hover:bg-muted transition-colors shrink-0"
		>
			<PriorityIcon priority={interval.priority} size={14} />
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end">
			<DropdownMenu.RadioGroup value={interval.priority} onValueChange={handlePriorityChange}>
				{#each priorityOptions as priority}
					<DropdownMenu.RadioItem value={priority}>
						<PriorityIcon {priority} size={14} />
						<span class="ml-2">{PriorityLabels[priority]}</span>
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<!-- Delete button -->
	<Button
		variant="ghost"
		size="icon-xs"
		onclick={handleDeleteClick}
		class="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
		title="Delete interval"
	>
		<Trash2 class="w-3.5 h-3.5" />
	</Button>
</div>

<AlertDialog.Root bind:open={showDeleteConfirm}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete interval?</AlertDialog.Title>
			<AlertDialog.Description>
				"{interval.title || 'Untitled'}" will be permanently deleted. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={handleConfirmDelete} class="bg-destructive text-destructive-foreground hover:bg-destructive/90">
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
