<script lang="ts">
  import { onMount } from "svelte";
  import { useLiveQuery } from "@tanstack/svelte-db";
  import { getFilterContext } from "$lib/contexts/filters.svelte";
  import IntervalListSkeleton from "$lib/components/IntervalListSkeleton.svelte";
  import { intervals as intervalsLazy, type Interval } from "$collections/useIntervals";
  import * as Table from "$lib/components/ui/table/index.js";
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
  } from "$lib/components/ui/data-table";
  import StatusCell from "./StatusCell.svelte";
  import PriorityCell from "./PriorityCell.svelte";
  import ActionsCell from "./ActionsCell.svelte";
  import TitleCell from "./TitleCell.svelte";
  import { infiniteScroll } from "$lib/actions/infiniteScroll";

  const collection = intervalsLazy.get();
  const intervalsQuery = useLiveQuery(collection);
  const filters = getFilterContext();
  const { pagination } = intervalsLazy;

  let canLoadMore = $state(pagination.canLoadMore);
  let isLoading = $state(pagination.status === "busy");

  onMount(() => {
    return pagination.subscribe((state) => {
      canLoadMore = state.status === "idle";
      isLoading = state.status === "busy";
    });
  });

  async function handleLoadMore() {
    if (!pagination.canLoadMore) return;
    await pagination.load();
  }

  const intervals = $derived(intervalsQuery.data ?? []) as Interval[];

  let sorting = $state<SortingState>([{ id: "updatedAt", desc: true }]);
  let columnFilters = $state<ColumnFiltersState>([]);

  $effect(() => {
    const newFilters: ColumnFiltersState = [];
    if (filters.statusFilter) {
      newFilters.push({ id: "status", value: filters.statusFilter });
    }
    if (filters.priorityFilter) {
      newFilters.push({ id: "priority", value: filters.priorityFilter });
    }
    columnFilters = newFilters;
  });

  const columns: ColumnDef<Interval>[] = [
    {
      accessorKey: "status",
      filterFn: "equals",
      cell: ({ row }) => renderComponent(StatusCell, { interval: row.original }),
    },
    {
      accessorKey: "title",
      cell: ({ row }) => renderComponent(TitleCell, { interval: row.original }),
    },
    {
      accessorKey: "priority",
      filterFn: "equals",
      cell: ({ row }) => renderComponent(PriorityCell, { interval: row.original }),
    },
    {
      accessorKey: "updatedAt",
      enableHiding: true,
    },
    {
      id: "actions",
      cell: ({ row }) => renderComponent(ActionsCell, { interval: row.original }),
    },
  ];

  const table = createSvelteTable<Interval>({
    get data() { return intervals; },
    columns,
    state: {
      get sorting() { return sorting; },
      get columnFilters() { return columnFilters; },
      get columnVisibility() { return { updatedAt: false }; },
    },
    onSortingChange: (updater) => {
      sorting = typeof updater === "function" ? updater(sorting) : updater;
    },
    onColumnFiltersChange: (updater) => {
      columnFilters = typeof updater === "function" ? updater(columnFilters) : updater;
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = $derived(table.getRowModel().rows);
</script>

{#if intervalsQuery.isLoading}
  <IntervalListSkeleton />
{:else}
<div class="flex-1 flex flex-col min-h-0">
  {#if rows.length === 0}
    <div class="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
      {#if intervals.length === 0}
        <p class="m-0">No intervals yet</p>
        <p class="text-xs opacity-60 mt-1">
          Press
          <kbd class="kbd-key">&#x2325;</kbd>
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
            <Table.Row class="group">
              {#each row.getVisibleCells() as cell (cell.id)}
                <Table.Cell class={cell.column.id === "title" ? "w-full" : "w-8 p-2"}>
                  <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
                </Table.Cell>
              {/each}
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
      
      {#if canLoadMore}
        <div 
          use:infiniteScroll={{ onLoadMore: handleLoadMore, hasMore: canLoadMore, rootMargin: "200px" }}
          class="flex justify-center py-4"
        >
          {#if isLoading}
            <span class="text-sm text-muted-foreground">Loading more...</span>
          {:else}
            <span class="text-xs text-muted-foreground/50">Scroll for more</span>
          {/if}
        </div>
      {:else if intervals.length > 0}
        <div class="flex justify-center py-4 text-xs text-muted-foreground/50">
          All {intervals.length} items loaded
        </div>
      {/if}
    </div>
  {/if}
</div>
{/if}
