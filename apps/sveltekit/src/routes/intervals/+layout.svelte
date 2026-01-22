<script lang="ts">
	import { useLiveQuery } from '@tanstack/svelte-db';
	import Navbar from '$lib/components/Navbar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MobileActionBar from '$lib/components/MobileActionBar.svelte';
	import MobileBackButton from '$lib/components/MobileBackButton.svelte';
	import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
	import SearchPanel from '$lib/components/SearchPanel.svelte';
	import FilterDialog from '$lib/components/FilterDialog.svelte';
	import { setFilterContext } from '$lib/contexts/filters.svelte';
	import { setIntervalsContext } from '$lib/contexts/intervals.svelte';
	import { intervals as intervalsLazy, type Interval } from '$collections/useIntervals';
	import { schema } from '@trestleinc/replicate/client';
	import { getAuthClient } from '$lib/auth-client';
	import type { StatusValue, PriorityValue } from '$lib/types';

	let { children } = $props();

	// UI state
	let searchOpen = $state(false);
	let filterOpen = $state(false);
	let mobileMenuOpen = $state(false);

	// Filter state
	let statusFilter = $state<StatusValue | null>(null);
	let priorityFilter = $state<PriorityValue | null>(null);

	const hasActiveFilters = $derived(statusFilter !== null || priorityFilter !== null);

	// Set filter context with reactive getters
	setFilterContext({
		get statusFilter() {
			return statusFilter;
		},
		get priorityFilter() {
			return priorityFilter;
		},
	});

	// Initialize collection and query once at layout level
	const collection = intervalsLazy.get();
	const intervalsQuery = useLiveQuery(collection);

	// Set intervals context with getter pattern for fine-grained reactivity
	setIntervalsContext({
		get data() {
			return (intervalsQuery.data ?? []) as Interval[];
		},
		get isLoading() {
			return intervalsQuery.isLoading;
		},
		collection,
	});

	// Get auth client for creating intervals
	let sessionData = $state<{ user?: { id: string } } | null>(null);

	$effect(() => {
		const authClient = getAuthClient();
		const session = authClient.useSession();
		const unsubscribe = session.subscribe((s) => {
			sessionData = s.data;
		});
		return unsubscribe;
	});

	function createInterval(isPublic: boolean = true) {
		const id = crypto.randomUUID();
		const now = Date.now();
		const user = sessionData?.user;
		collection.insert({
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
	}
</script>

<div class="app-layout">
	<!-- Top Navbar -->
	<Navbar
		onsearchopen={() => (searchOpen = true)}
		onfilteropen={() => (filterOpen = true)}
		oncreate={() => createInterval(true)}
		{hasActiveFilters}
		onmenuopen={() => (mobileMenuOpen = !mobileMenuOpen)}
	/>

	<!-- Main content area with sidebar -->
	<div class="app-main">
		<Sidebar
			onsearchopen={() => (searchOpen = true)}
			onfilteropen={() => (filterOpen = true)}
			{hasActiveFilters}
		/>

		<main class="main-content">
			<div class="main-scroll-area">
				{@render children()}
			</div>
		</main>
	</div>

	<!-- Keyboard shortcuts -->
	<KeyboardShortcuts onsearchopen={() => (searchOpen = true)} />

	<!-- Search panel -->
	<SearchPanel bind:open={searchOpen} onclose={() => (searchOpen = false)} />

	<!-- Filter dialog -->
	<FilterDialog
		bind:open={filterOpen}
		onclose={() => (filterOpen = false)}
		{statusFilter}
		{priorityFilter}
		onstatuschange={(s) => (statusFilter = s)}
		onprioritychange={(p) => (priorityFilter = p)}
	/>

	<!-- Mobile navigation -->
	<MobileBackButton />
	<MobileActionBar
		onsearchopen={() => (searchOpen = true)}
		onfilteropen={() => (filterOpen = true)}
		{hasActiveFilters}
	/>
</div>
