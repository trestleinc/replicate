<script lang="ts">
  import StatusIcon from "$lib/components/StatusIcon.svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Status, StatusLabels, type StatusValue } from "$lib/types";
  import { intervals, type Interval } from "$collections/useIntervals";

  type Props = { interval: Interval };
  const { interval }: Props = $props();

  const collection = intervals.get();
  const statusOptions = Object.values(Status) as StatusValue[];

  function handleStatusChange(newStatus: string) {
    collection.update(interval.id, (draft) => {
      draft.status = newStatus as StatusValue;
      draft.updatedAt = Date.now();
    });
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class="flex items-center rounded-sm hover:bg-muted transition-colors">
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
