<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
</script>

{#snippet IntervalRowSkeleton()}
  <div class="flex items-center gap-3 px-6 py-3 border-b border-border">
    <!-- Status icon -->
    <Skeleton class="h-4 w-4 rounded-full shrink-0" />

    <!-- Title and preview -->
    <div class="flex-1 min-w-0 flex flex-col gap-1">
      <Skeleton class="h-4 w-1/3" />
      <Skeleton class="h-3 w-2/3" />
    </div>

    <!-- Priority icon -->
    <Skeleton class="h-4 w-4 shrink-0" />
  </div>
{/snippet}

<div class="flex-1 flex flex-col min-h-0">
  <div class="flex-1 overflow-auto">
    <div class="flex flex-col">
      {@render IntervalRowSkeleton()}
      {@render IntervalRowSkeleton()}
      {@render IntervalRowSkeleton()}
      {@render IntervalRowSkeleton()}
      {@render IntervalRowSkeleton()}
    </div>
  </div>
</div>
