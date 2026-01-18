<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	// Redirect to intervals
	onMount(() => {
		goto('/intervals');
	});
</script>

<div class="flex items-center justify-center min-h-screen">
	<p class="text-muted-foreground">Redirecting...</p>
</div>
