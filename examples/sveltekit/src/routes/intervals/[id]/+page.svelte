<script lang="ts">
  import { page } from "$app/state";
  import { useLiveQuery } from "@tanstack/svelte-db";
  import IntervalEditor from "$lib/components/IntervalEditor.svelte";
  import IntervalEditorSkeleton from "$lib/components/IntervalEditorSkeleton.svelte";
  import CommentList from "$lib/components/CommentList.svelte";
  import { intervals, type Interval } from "$collections/useIntervals";

  const collection = intervals.get();
  const id = $derived(page.params.id);

  const intervalsQuery = useLiveQuery(collection);

  // Cache last known valid interval to handle transient null states during updates
  let lastKnownInterval = $state<Interval | null>(null);

  const currentInterval = $derived(
    ((intervalsQuery.data ?? [])).find(i => i.id === id) ?? null,
  );

  // Update cache only when we have a valid result
  $effect(() => {
    if (currentInterval !== null) {
      lastKnownInterval = currentInterval;
    }
  });

  // Use current or cached interval
  const interval = $derived(currentInterval ?? lastKnownInterval);

  // True "not found" only when: not loading, no current, no valid cache for this ID
  const notFound = $derived(
    !intervalsQuery.isLoading &&
    currentInterval === null &&
    (lastKnownInterval === null || lastKnownInterval.id !== id)
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

{#if intervalsQuery.isLoading && !lastKnownInterval}
  <IntervalEditorSkeleton />
{:else if notFound}
  <div class="flex-1 flex items-center justify-center">
    <div class="text-center text-muted-foreground">
      <p>Interval not found</p>
    </div>
  </div>
{:else if interval && id}
  <div class="flex-1 overflow-auto">
    {#key id}
      <IntervalEditor intervalId={id} {interval} onPropertyUpdate={handlePropertyUpdate} />
    {/key}
    <CommentList intervalId={id} isPublic={interval.isPublic} />
  </div>
{/if}
