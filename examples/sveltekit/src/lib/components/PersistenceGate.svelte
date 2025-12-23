<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { browser } from '$app/environment';
	import { intervals } from '$collections/useIntervals';
	import { comments } from '$collections/useComments';
	import type { Materialized } from '@trestleinc/replicate/client';
	import type { Interval, Comment } from '$lib/types';

	let {
		children,
		intervalsMaterial,
		commentsMaterial,
	}: {
		children: Snippet;
		intervalsMaterial?: Materialized<Interval>;
		commentsMaterial?: Materialized<Comment>;
	} = $props();

	let ready = $state(false);
	let error = $state<string | null>(null);

	onMount(async () => {
		if (!browser) return;

		try {
			await Promise.all([
				intervals.init(intervalsMaterial),
				comments.init(commentsMaterial),
			]);
			ready = true;
		} catch (err) {
			console.error('[PersistenceGate] Failed:', err);
			error = err instanceof Error ? err.message : 'Unknown error';
		}
	});
</script>

{#if ready}
	{@render children()}
{:else if error}
	<div class="flex items-center justify-center h-screen">
		<div class="text-center">
			<p class="text-destructive mb-2">Failed to initialize: {error}</p>
			<button class="text-sm underline" onclick={() => location.reload()}>Retry</button>
		</div>
	</div>
{:else}
	<div class="flex items-center justify-center h-screen">
		<p class="text-muted-foreground">Loading...</p>
	</div>
{/if}
