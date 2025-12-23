<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { ArrowLeft } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	// Only show when on a detail page (has an id param)
	const isDetailPage = $derived(
		page.url.pathname.startsWith('/intervals/') && page.url.pathname !== '/intervals'
	);
</script>

{#if isDetailPage}
	<!-- Left Island: Back Button (only on detail pages) -->
	<div class="floating-island floating-island-back">
		<div class="p-1">
			<Button
				variant="ghost"
				size="icon"
				onclick={() => goto('/intervals')}
				aria-label="Back to intervals"
				class="h-10 w-10"
			>
				<ArrowLeft class="w-5 h-5" />
			</Button>
		</div>
	</div>
{/if}
