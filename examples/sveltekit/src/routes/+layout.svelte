<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { setConvexClientContext } from 'convex-svelte';
	import { ConvexClient } from 'convex/browser';
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	import PersistenceGate from '$lib/components/PersistenceGate.svelte';

	let { children } = $props();

	onMount(() => {
		setConvexClientContext(new ConvexClient(PUBLIC_CONVEX_URL));

		if (!dev && 'serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js');
		}
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<PersistenceGate intervalsMaterial={page.data.intervalsMaterial} commentsMaterial={page.data.commentsMaterial}>
	{@render children()}
</PersistenceGate>
