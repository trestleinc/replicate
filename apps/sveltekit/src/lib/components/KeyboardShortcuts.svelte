<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import { schema } from '@trestleinc/replicate/client';

	type Props = {
		onsearchopen: () => void;
	};

	const { onsearchopen }: Props = $props();

	// Get collection from context for mutations
	const intervalsCtx = getIntervalsContext();

	function createInterval() {
		const id = crypto.randomUUID();
		const now = Date.now();
		intervalsCtx.collection.insert({
			id,
			isPublic: true,
			title: 'New Interval',
			description: schema.prose.empty(),
			status: 'backlog',
			priority: 'none',
			createdAt: now,
			updatedAt: now,
		});
		goto(resolve(`/intervals/${id}`));
	}

	// Use $effect for event listeners (Svelte 5 pattern)
	$effect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			// Don't trigger shortcuts when typing in inputs/textareas
			const target = e.target as HTMLElement;
			if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
				return;
			}

			// Cmd+K or Ctrl+K: Open search
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				onsearchopen();
			}

			// Option+N (Alt+N): Create new interval
			if (e.altKey && e.code === 'KeyN') {
				e.preventDefault();
				createInterval();
			}
		}

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	});
</script>
