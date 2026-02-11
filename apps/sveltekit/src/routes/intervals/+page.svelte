<script lang="ts">
	import { getFilterContext } from '$lib/contexts/filters.svelte';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import { intervals as intervalsLazy, type Interval } from '$collections/useIntervals';
	import IntervalListSkeleton from '$lib/components/IntervalListSkeleton.svelte';
	import * as Table from '$lib/components/ui/table/index.js';
	import {
		createSvelteTable,
		FlexRender,
		renderComponent,
		getCoreRowModel,
		getFilteredRowModel,
		getSortedRowModel,
		type ColumnDef,
		type SortingState,
		type ColumnFiltersState,
	} from '$lib/components/ui/data-table';
	import StatusCell from './StatusCell.svelte';
	import PriorityCell from './PriorityCell.svelte';
	import ActionsCell from './ActionsCell.svelte';
	import TitleCell from './TitleCell.svelte';
	import { infiniteScroll } from '$lib/actions/infiniteScroll';

	// Get data from context (single source of truth)
	const intervalsCtx = getIntervalsContext();
	const filters = getFilterContext();
	const { pagination } = intervalsLazy;

	// Pagination state with $derived (not $state + $effect)
	const canLoadMore = $derived(pagination.canLoadMore && pagination.status === 'idle');
	const isLoadingMore = $derived(pagination.status === 'busy');

	async function handleLoadMore() {
		if (!pagination.canLoadMore) return;
		await pagination.load();
	}

	// Get intervals from context
	const intervals = $derived(intervalsCtx.data);

	// Sorting state
	let sorting = $state<SortingState>([{ id: 'updatedAt', desc: true }]);

	// PERFORMANCE FIX: Use $derived.by instead of $effect for columnFilters
	const columnFilters = $derived.by(() => {
		const newFilters: ColumnFiltersState = [];
		if (filters.statusFilter) {
			newFilters.push({ id: 'status', value: filters.statusFilter });
		}
		if (filters.priorityFilter) {
			newFilters.push({ id: 'priority', value: filters.priorityFilter });
		}
		return newFilters;
	});

	const columns: ColumnDef<Interval>[] = [
		{
			accessorKey: 'status',
			filterFn: 'equals',
			cell: ({ row }) => renderComponent(StatusCell, { interval: row.original }),
		},
		{
			accessorKey: 'title',
			cell: ({ row }) => renderComponent(TitleCell, { interval: row.original }),
		},
		{
			accessorKey: 'priority',
			filterFn: 'equals',
			cell: ({ row }) => renderComponent(PriorityCell, { interval: row.original }),
		},
		{
			accessorKey: 'updatedAt',
			enableHiding: true,
		},
		{
			id: 'actions',
			cell: ({ row }) => renderComponent(ActionsCell, { interval: row.original }),
		},
	];

	const table = createSvelteTable<Interval>({
		get data() {
			return intervals;
		},
		columns,
		state: {
			get sorting() {
				return sorting;
			},
			get columnFilters() {
				return columnFilters;
			},
			get columnVisibility() {
				return { updatedAt: false };
			},
		},
		onSortingChange: (updater) => {
			sorting = typeof updater === 'function' ? updater(sorting) : updater;
		},
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});

	const rows = $derived(table.getRowModel().rows);
</script>

{#if intervalsCtx.isLoading}
	<IntervalListSkeleton />
{:else}
	<div class="flex min-h-0 flex-1 flex-col">
		{#if rows.length === 0}
			<div
				class="text-muted-foreground flex flex-col items-center justify-center py-16 text-center"
			>
				{#if intervals.length === 0}
					<p class="m-0 font-medium">No intervals yet</p>
					<p class="mt-2 text-xs opacity-60">
						Press
						<kbd class="kbd-key">⌥</kbd>
						<kbd class="kbd-key">N</kbd>
						to create your first interval
					</p>
				{:else}
					<p class="m-0">No intervals match your filters</p>
				{/if}
			</div>
		{:else}
			<div class="flex-1 overflow-auto">
				<Table.Root>
					<Table.Body>
						{#each rows as row (row.id)}
							<Table.Row class="group data-table-row">
								{#each row.getVisibleCells() as cell (cell.id)}
									<Table.Cell class={cell.column.id === 'title' ? 'w-full' : 'w-8 p-2'}>
										<FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>

				{#if canLoadMore}
					<div
						use:infiniteScroll={{
							onLoadMore: handleLoadMore,
							hasMore: canLoadMore,
							rootMargin: '200px',
						}}
						class="flex justify-center py-4"
					>
						{#if isLoadingMore}
							<span class="text-muted-foreground text-sm">Loading more...</span>
						{:else}
							<span class="text-muted-foreground/50 text-xs">Scroll for more</span>
						{/if}
					</div>
				{:else if intervals.length > 0}
					<div class="text-muted-foreground/50 flex justify-center py-4 text-xs">
						All {intervals.length} items loaded
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
