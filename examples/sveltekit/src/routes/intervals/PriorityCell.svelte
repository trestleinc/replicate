<script lang="ts">
  import PriorityIcon from "$lib/components/PriorityIcon.svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Priority, PriorityLabels, type PriorityValue } from "$lib/types";
  import { intervals, type Interval } from "$collections/useIntervals";

  type Props = { interval: Interval };
  const { interval }: Props = $props();

  const collection = intervals.get();
  const priorityOptions = Object.values(Priority) as PriorityValue[];

  function handlePriorityChange(newPriority: string) {
    collection.update(interval.id, (draft) => {
      draft.priority = newPriority as PriorityValue;
      draft.updatedAt = Date.now();
    });
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class="flex items-center rounded-sm hover:bg-muted transition-colors">
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
