<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton";
</script>

<div class="max-w-[680px] mx-auto px-8 py-12 w-full">
  <!-- Title skeleton -->
  <Skeleton class="h-9 w-2/3 mb-4" />

  <!-- Properties row skeleton -->
  <div class="flex items-center gap-4 mt-4 mb-8 pb-6 border-b border-border">
    <Skeleton class="h-7 w-24" />
    <Skeleton class="h-7 w-24" />
  </div>

  <!-- Editor content skeleton -->
  <div class="space-y-3 min-h-[200px]">
    <Skeleton class="h-4 w-full" />
    <Skeleton class="h-4 w-full" />
    <Skeleton class="h-4 w-4/5" />
    <Skeleton class="h-4 w-full" />
    <Skeleton class="h-4 w-3/5" />
  </div>
</div>
