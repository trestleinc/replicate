<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MobileActionBar from '$lib/components/MobileActionBar.svelte';
	import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
	import SearchPanel from '$lib/components/SearchPanel.svelte';
	import FilterDialog from '$lib/components/FilterDialog.svelte';
	import { setFilterContext } from '$lib/contexts/filters.svelte';
	import type { StatusValue, PriorityValue } from '$lib/types';

	let { children } = $props();

	let searchOpen = $state(false);
	let filterOpen = $state(false);
	let statusFilter = $state<StatusValue | null>(null);
	let priorityFilter = $state<PriorityValue | null>(null);

	const hasActiveFilters = $derived(statusFilter !== null || priorityFilter !== null);

	// Create reactive context object that updates when filters change
	const filterContext = $derived({
		statusFilter,
		priorityFilter
	});

	// Set context with reactive getters
	setFilterContext({
		get statusFilter() {
			return statusFilter;
		},
		get priorityFilter() {
			return priorityFilter;
		}
	});
</script>

<div class="app-layout">
	<Sidebar
		onsearchopen={() => (searchOpen = true)}
		onfilteropen={() => (filterOpen = true)}
		{hasActiveFilters}
	/>

	<main class="main-content">
		{@render children()}
	</main>

	<KeyboardShortcuts onsearchopen={() => (searchOpen = true)} />
	<SearchPanel bind:open={searchOpen} onclose={() => (searchOpen = false)} />
	<FilterDialog
		bind:open={filterOpen}
		onclose={() => (filterOpen = false)}
		{statusFilter}
		{priorityFilter}
		onstatuschange={(s) => (statusFilter = s)}
		onprioritychange={(p) => (priorityFilter = p)}
	/>
	<MobileActionBar
		onsearchopen={() => (searchOpen = true)}
		onfilteropen={() => (filterOpen = true)}
		{hasActiveFilters}
	/>
</div>
