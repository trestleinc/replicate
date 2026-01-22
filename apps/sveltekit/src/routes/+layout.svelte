<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { configure, getConsoleSink } from '@logtape/logtape';
	import { createSvelteAuthClient } from '@mmailaender/convex-better-auth-svelte/svelte';
	import { getAuthClient } from '$lib/auth-client';
	import { getConvexClient } from '$lib/convex';
	import PersistenceGate from '$lib/components/PersistenceGate.svelte';
	import { getPublicEnvError } from '$lib/env';

	let { children } = $props();

	const envError = getPublicEnvError();

	onMount(async () => {
		// Initialize auth client in browser only
		const authClient = getAuthClient();
		const convexClient = getConvexClient();
		createSvelteAuthClient({ authClient, convexClient });

		await configure({
			sinks: { console: getConsoleSink() },
			loggers: [{ category: ['replicate'], lowestLevel: 'debug', sinks: ['console'] }],
		});

		if (!dev && 'serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js');
		}
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if envError}
	<div class="bg-destructive/10 flex min-h-screen items-center justify-center p-4">
		<div class="border-destructive bg-background max-w-md rounded border p-6 text-center">
			<h1 class="text-destructive mb-2 text-lg font-semibold">Configuration Error</h1>
			<p class="text-muted-foreground text-sm">{envError}</p>
		</div>
	</div>
{:else}
	<PersistenceGate
		enableEncryption={false}
		intervalsMaterial={page.data.intervalsMaterial}
		commentsMaterial={page.data.commentsMaterial}
	>
		{@render children()}
	</PersistenceGate>
{/if}
