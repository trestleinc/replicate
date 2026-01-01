<script lang="ts">
  import { page } from "$app/state";
  import { useLiveQuery } from "@tanstack/svelte-db";
  import IntervalEditor from "$lib/components/IntervalEditor.svelte";
  import IntervalEditorSkeleton from "$lib/components/IntervalEditorSkeleton.svelte";
  import CommentList from "$lib/components/CommentList.svelte";
  import type { Interval } from "$lib/types";
  import { intervals } from "$collections/useIntervals";

  const collection = intervals.get();
  const id = $derived(page.params.id);

  const intervalsQuery = useLiveQuery(collection);

  const interval = $derived(
    ((intervalsQuery.data ?? [])).find(i => i.id === id) ?? null,
  );

  function handlePropertyUpdate(updates: Partial<Pick<Interval, "status" | "priority">>) {
    if (interval) {
      collection.update(interval.id, (draft) => {
        if (updates.status !== undefined) draft.status = updates.status;
        if (updates.priority !== undefined) draft.priority = updates.priority;
        draft.updatedAt = Date.now();
      });
    }
  }
</script>

{#if intervalsQuery.isLoading}
  <IntervalEditorSkeleton />
{:else if !interval}
  <div class="flex-1 flex items-center justify-center">
    <div class="text-center text-muted-foreground">
      <p>Interval not found</p>
    </div>
  </div>
{:else if id}
  <div class="flex-1 overflow-auto">
    {#key id}
      <IntervalEditor intervalId={id} {interval} onPropertyUpdate={handlePropertyUpdate} />
    {/key}
    <CommentList intervalId={id} />
  </div>
{/if}
