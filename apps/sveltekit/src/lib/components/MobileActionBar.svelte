<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Search, Plus, SlidersHorizontal } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import { getAuthClient } from '$lib/auth-client';
	import { schema } from '@trestleinc/replicate/client';

	type Props = {
		onsearchopen: () => void;
		onfilteropen: () => void;
		hasActiveFilters?: boolean;
	};

	const { onsearchopen, onfilteropen, hasActiveFilters = false }: Props = $props();

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
</script>

<!-- Right Island: Actions (Search, Filter, Create) -->
<div class="floating-island floating-island-actions">
	<div class="flex items-center gap-1 p-1">
		<Button
			variant="ghost"
			size="icon"
			onclick={onsearchopen}
			aria-label="Search intervals"
			class="h-10 w-10"
		>
			<Search class="h-5 w-5" />
		</Button>
		<div class="bg-border h-6 w-px"></div>
		<Button
			variant="ghost"
			size="icon"
			onclick={onfilteropen}
			aria-label="Filter intervals"
			class={cn('h-10 w-10', hasActiveFilters && 'text-primary')}
		>
			<SlidersHorizontal class="h-5 w-5" />
		</Button>
		<div class="bg-border h-6 w-px"></div>
		<Button
			variant="ghost"
			size="icon"
			onclick={createInterval}
			aria-label="New interval"
			class="h-10 w-10"
		>
			<Plus class="h-5 w-5" />
		</Button>
	</div>
</div>
