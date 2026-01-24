import { useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	useReactTable,
	type ColumnFiltersState,
	type SortingState,
} from '@tanstack/react-table';
import { useIntervalsContext } from '../contexts/IntervalsContext';
import { useFilterContext } from '../routes/__root';
import { IntervalListSkeleton } from './IntervalListSkeleton';
import { StatusIcon } from './StatusIcon';
import { PriorityIcon } from './PriorityIcon';
import { Button } from './ui/button';
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from './ui/dropdown-menu';
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogCancel,
	AlertDialogAction,
} from './ui/alert-dialog';
import {
	Status,
	Priority,
	StatusLabels,
	PriorityLabels,
	type Interval,
	type StatusValue,
	type PriorityValue,
} from '../types/interval';

function StatusCell({ interval }: { interval: Interval }) {
	const { collection } = useIntervalsContext();
	const statusOptions = Object.values(Status) as StatusValue[];

	const handleStatusChange = (newStatus: string) => {
		collection.update(interval.id, (draft: Interval) => {
			draft.status = newStatus as StatusValue;
		});
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="hover:bg-muted -m-1 flex items-center p-1 transition-colors">
				<StatusIcon status={interval.status} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuRadioGroup value={interval.status} onValueChange={handleStatusChange}>
					{statusOptions.map((status) => (
						<DropdownMenuRadioItem key={status} value={status}>
							<StatusIcon status={status} size={14} />
							{StatusLabels[status]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function PriorityCell({ interval }: { interval: Interval }) {
	const { collection } = useIntervalsContext();
	const priorityOptions = Object.values(Priority) as PriorityValue[];

	const handlePriorityChange = (newPriority: string) => {
		collection.update(interval.id, (draft: Interval) => {
			draft.priority = newPriority as PriorityValue;
		});
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="hover:bg-muted -m-1 flex items-center p-1 transition-colors">
				<PriorityIcon priority={interval.priority} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup value={interval.priority} onValueChange={handlePriorityChange}>
					{priorityOptions.map((priority) => (
						<DropdownMenuRadioItem key={priority} value={priority}>
							<PriorityIcon priority={priority} size={14} />
							{PriorityLabels[priority]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function DeleteCell({ interval }: { interval: Interval }) {
	const { collection } = useIntervalsContext();
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

	const handleDeleteClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setShowDeleteConfirm(true);
	};

	const handleConfirmDelete = () => {
		collection.delete(interval.id);
		setShowDeleteConfirm(false);
	};

	return (
		<>
			<Button
				variant="ghost"
				size="icon-xs"
				onClick={handleDeleteClick}
				className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 transition-opacity group-hover:opacity-100"
				title="Delete interval"
			>
				<Trash2 className="h-3.5 w-3.5" />
			</Button>

			<AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete interval?</AlertDialogTitle>
						<AlertDialogDescription>
							&ldquo;
							{interval.title || 'Untitled'}
							&rdquo; will be permanently deleted. This action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={handleConfirmDelete}>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

export function IntervalList() {
	const { intervals, isLoading } = useIntervalsContext();
	const { statusFilter, priorityFilter } = useFilterContext();
	const tableContainerRef = useRef<HTMLDivElement>(null);

	const columnFilters = useMemo<ColumnFiltersState>(() => {
		const filters: ColumnFiltersState = [];
		if (statusFilter) {
			filters.push({ id: 'status', value: statusFilter });
		}
		if (priorityFilter) {
			filters.push({ id: 'priority', value: priorityFilter });
		}
		return filters;
	}, [statusFilter, priorityFilter]);

	const sorting = useMemo<SortingState>(() => [{ id: 'updatedAt', desc: true }], []);

	const table = useReactTable({
		data: intervals,
		columns: [
			{ accessorKey: 'status', filterFn: 'equals' },
			{ accessorKey: 'title' },
			{ accessorKey: 'priority', filterFn: 'equals' },
			{ accessorKey: 'updatedAt', enableHiding: true },
		],
		state: {
			sorting,
			columnFilters,
			columnVisibility: { updatedAt: false },
		},
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});

	const { rows } = table.getRowModel();

	const rowVirtualizer = useVirtualizer({
		count: rows.length,
		estimateSize: () => 40,
		getScrollElement: () => tableContainerRef.current,
		measureElement:
			typeof window !== 'undefined' && !navigator.userAgent.includes('Firefox')
				? (element) => element?.getBoundingClientRect().height
				: undefined,
		overscan: 10,
	});

	if (isLoading) {
		return <IntervalListSkeleton />;
	}

	if (rows.length === 0) {
		return (
			<div className="text-muted-foreground flex flex-1 flex-col items-center justify-center py-16 text-center">
				{intervals.length === 0 ? (
					<>
						<p className="m-0">No intervals yet</p>
						<p className="mt-1 text-xs opacity-60">
							Press <kbd className="kbd-key">&#x2325;</kbd> <kbd className="kbd-key">N</kbd> to
							create your first interval
						</p>
					</>
				) : (
					<p className="m-0">No intervals match your filters</p>
				)}
			</div>
		);
	}

	return (
		<div ref={tableContainerRef} className="flex-1 overflow-auto" style={{ position: 'relative' }}>
			<table style={{ display: 'grid', width: '100%' }}>
				<tbody
					style={{
						display: 'grid',
						height: `${rowVirtualizer.getTotalSize()}px`,
						position: 'relative',
					}}
				>
					{rowVirtualizer.getVirtualItems().map((virtualRow) => {
						const row = rows[virtualRow.index];
						const interval = row.original as Interval;
						return (
							<tr
								key={row.id}
								data-index={virtualRow.index}
								ref={(node) => rowVirtualizer.measureElement(node)}
								className="border-border group flex w-full items-center border-b transition-colors hover:bg-[var(--color-muted)]/50"
								style={{
									position: 'absolute',
									transform: `translateY(${virtualRow.start}px)`,
								}}
							>
								<td className="w-8 shrink-0 p-2">
									<StatusCell interval={interval} />
								</td>
								<td className="min-w-0 flex-1 px-2 py-2">
									<Link
										to="/intervals/$intervalId"
										params={{ intervalId: interval.id }}
										className="text-foreground hover:text-primary block truncate text-sm font-medium no-underline transition-colors"
									>
										{interval.title || 'Untitled'}
									</Link>
								</td>
								<td className="w-8 shrink-0 p-2">
									<PriorityCell interval={interval} />
								</td>
								<td className="w-8 shrink-0 p-2">
									<DeleteCell interval={interval} />
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
