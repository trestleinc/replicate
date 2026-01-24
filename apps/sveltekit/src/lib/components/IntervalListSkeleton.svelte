<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton';
</script>

{#snippet IntervalRowSkeleton()}
	<div class="border-border flex items-center gap-3 border-b px-6 py-3">
		<!-- Status icon -->
		<Skeleton class="h-4 w-4 shrink-0 rounded-full" />

		<!-- Title and preview -->
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<Skeleton class="h-4 w-1/3" />
			<Skeleton class="h-3 w-2/3" />
		</div>

		<!-- Priority icon -->
		<Skeleton class="h-4 w-4 shrink-0" />
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
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
