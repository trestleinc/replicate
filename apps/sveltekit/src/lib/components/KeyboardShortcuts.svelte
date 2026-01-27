<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import { getAuthClient } from '$lib/auth-client';
	import { schema } from '@trestleinc/replicate/client';

	type Props = {
		onsearchopen: () => void;
	};

	const { onsearchopen }: Props = $props();

	// Get collection from context for mutations
	const intervalsCtx = getIntervalsContext();

	// Auth state for determining default visibility
	let sessionData = $state<{ user?: { id: string } } | null>(null);

	$effect(() => {
		const authClient = getAuthClient();
		const session = authClient.useSession();
		const unsubscribe = session.subscribe((s) => {
			sessionData = s.data;
		});
		return unsubscribe;
	});

	function createInterval() {
		const id = crypto.randomUUID();
		const now = Date.now();
		const user = sessionData?.user;
		// Default to private if authenticated, public if anonymous
		const isPublic = !user;
		intervalsCtx.collection.insert({
			id,
			ownerId: user?.id,
			isPublic,
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
