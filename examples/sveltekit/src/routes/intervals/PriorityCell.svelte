<script module lang="ts">
	import { Priority, PriorityLabels } from "$lib/types";
	import type { PriorityValue } from "$lib/types";

	// PERFORMANCE: Static array at module scope - shared across all instances
	const priorityOptions = Object.values(Priority) as PriorityValue[];
</script>

<script lang="ts">
	import PriorityIcon from "$lib/components/PriorityIcon.svelte";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
	import { getIntervalsContext } from "$lib/contexts/intervals.svelte";
	import type { Interval } from "$collections/useIntervals";

	type Props = { interval: Interval };
	const { interval }: Props = $props();

	// Get collection from context for mutations
	const intervalsCtx = getIntervalsContext();

	function handlePriorityChange(newPriority: string) {
		intervalsCtx.collection.update(interval.id, (draft) => {
			draft.priority = newPriority as PriorityValue;
			draft.updatedAt = Date.now();
		});
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class="flex items-center hover:bg-muted transition-fast p-1 -m-1">
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
