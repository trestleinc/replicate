<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton';
</script>

<div class="mx-auto w-full max-w-[680px] px-8 py-12">
	<!-- Title skeleton -->
	<Skeleton class="mb-4 h-9 w-2/3" />

	<!-- Properties row skeleton -->
	<div class="border-border mt-4 mb-8 flex items-center gap-4 border-b pb-6">
		<Skeleton class="h-7 w-24" />
		<Skeleton class="h-7 w-24" />
	</div>

	<!-- Editor content skeleton -->
	<div class="min-h-[200px] space-y-3">
		<Skeleton class="h-4 w-full" />
		<Skeleton class="h-4 w-full" />
		<Skeleton class="h-4 w-4/5" />
		<Skeleton class="h-4 w-full" />
		<Skeleton class="h-4 w-3/5" />
	</div>
</div>
