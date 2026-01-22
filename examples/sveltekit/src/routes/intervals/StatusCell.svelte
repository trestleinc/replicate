<script module lang="ts">
	import { Status, StatusLabels } from "$lib/types";
	import type { StatusValue } from "$lib/types";

	// PERFORMANCE: Static array at module scope - shared across all instances
	const statusOptions = Object.values(Status) as StatusValue[];
</script>

<script lang="ts">
	import StatusIcon from "$lib/components/StatusIcon.svelte";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
	import { getIntervalsContext } from "$lib/contexts/intervals.svelte";
	import type { Interval } from "$collections/useIntervals";

	type Props = { interval: Interval };
	const { interval }: Props = $props();

	// Get collection from context for mutations
	const intervalsCtx = getIntervalsContext();

	function handleStatusChange(newStatus: string) {
		intervalsCtx.collection.update(interval.id, (draft) => {
			draft.status = newStatus as StatusValue;
			draft.updatedAt = Date.now();
		});
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class="flex items-center hover:bg-muted transition-fast p-1 -m-1">
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
