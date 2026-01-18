<script lang="ts">
  import { Trash2 } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { intervals, type Interval } from "$collections/useIntervals";

  type Props = { interval: Interval };
  const { interval }: Props = $props();

  const collection = intervals.get();
  let showDeleteConfirm = $state(false);

  function handleDeleteClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    showDeleteConfirm = true;
  }

  function handleConfirmDelete() {
    collection.delete(interval.id);
    showDeleteConfirm = false;
  }
</script>

<Button
  variant="ghost"
  size="icon-xs"
  onclick={handleDeleteClick}
  class="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
  title="Delete interval"
>
  <Trash2 class="w-3.5 h-3.5" />
</Button>

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
      <AlertDialog.Action
        onclick={handleConfirmDelete}
        class="bg-transparent border border-destructive text-destructive hover:bg-destructive/10"
      >
        Delete
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
