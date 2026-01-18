<script lang="ts">
	import "./layout.css";
	import favicon from "$lib/assets/favicon.svg";
	import { page } from "$app/state";
	import { onMount } from "svelte";
	import { dev, browser } from "$app/environment";
	import { configure, getConsoleSink } from "@logtape/logtape";
	import { createSvelteAuthClient } from "@mmailaender/convex-better-auth-svelte/svelte";
	import { getAuthClient } from "$lib/auth-client";
	import { getConvexClient } from "$lib/convex";
	import PersistenceGate from "$lib/components/PersistenceGate.svelte";

	let { children } = $props();

	onMount(async () => {
		// Initialize auth client in browser only
		const authClient = getAuthClient();
		const convexClient = getConvexClient();
		createSvelteAuthClient({ authClient, convexClient });

		await configure({
			sinks: { console: getConsoleSink() },
			loggers: [
				{ category: ["replicate"], lowestLevel: "debug", sinks: ["console"] },
			],
		});

		if (!dev && "serviceWorker" in navigator) {
			navigator.serviceWorker.register("/service-worker.js");
		}
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<PersistenceGate enableEncryption={false} intervalsMaterial={page.data.intervalsMaterial} commentsMaterial={page.data.commentsMaterial}>
	{@render children()}
</PersistenceGate>
