import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from "@tanstack/react-table";
import { useIntervalsContext } from "../contexts/IntervalsContext";
import { useFilterContext } from "../routes/__root";
import { IntervalListSkeleton } from "./IntervalListSkeleton";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Button } from "./ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "./ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";
import {
  Status,
  Priority,
  StatusLabels,
  PriorityLabels,
  type Interval,
  type StatusValue,
  type PriorityValue,
} from "../types/interval";

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
      <DropdownMenuTrigger
        className="flex items-center rounded-sm hover:bg-muted transition-colors"
      >
        <StatusIcon status={interval.status} size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={interval.status} onValueChange={handleStatusChange}>
          {statusOptions.map(status => (
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
      <DropdownMenuTrigger
        className="flex items-center rounded-sm hover:bg-muted transition-colors"
      >
        <PriorityIcon priority={interval.priority} size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={interval.priority} onValueChange={handlePriorityChange}>
          {priorityOptions.map(priority => (
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
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        title="Delete interval"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete interval?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;
              {interval.title || "Untitled"}
              &rdquo; will be permanently deleted.
              This action cannot be undone.
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

const columns: ColumnDef<Interval>[] = [
  {
    accessorKey: "status",
    cell: ({ row }) => <StatusCell interval={row.original} />,
    filterFn: "equals",
    size: 32,
  },
  {
    accessorKey: "title",
    cell: ({ row }) => (
      <Link
        to="/intervals/$intervalId"
        params={{ intervalId: row.original.id }}
        className="block no-underline text-foreground"
      >
        <span className="text-sm font-medium truncate">
          {row.original.title || "Untitled"}
        </span>
      </Link>
    ),
  },
  {
    accessorKey: "priority",
    cell: ({ row }) => <PriorityCell interval={row.original} />,
    filterFn: "equals",
    size: 32,
  },
  {
    accessorKey: "updatedAt",
    enableHiding: true,
  },
  {
    id: "actions",
    cell: ({ row }) => <DeleteCell interval={row.original} />,
    size: 32,
  },
];

export function IntervalList() {
  const { intervals, isLoading } = useIntervalsContext();
  const { statusFilter, priorityFilter } = useFilterContext();

  const columnFilters = useMemo<ColumnFiltersState>(() => {
    const filters: ColumnFiltersState = [];
    if (statusFilter) {
      filters.push({ id: "status", value: statusFilter });
    }
    if (priorityFilter) {
      filters.push({ id: "priority", value: priorityFilter });
    }
    return filters;
  }, [statusFilter, priorityFilter]);

  const sorting = useMemo<SortingState>(() => [
    { id: "updatedAt", desc: true },
  ], []);

  const table = useReactTable({
    data: intervals,
    columns,
    state: {
      sorting,
      columnFilters,
      columnVisibility: { updatedAt: false },
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;

  if (isLoading) {
    return <IntervalListSkeleton />;
  }

  if (rows.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className="flex flex-col items-center justify-center py-16
            text-muted-foreground text-center"
        >
          {intervals.length === 0
            ? (
                <>
                  <p className="m-0">No intervals yet</p>
                  <p className="text-xs opacity-60 mt-1">
                    Press
                    {" "}
                    <kbd className="kbd-key">&#x2325;</kbd>
                    {" "}
                    <kbd className="kbd-key">N</kbd>
                    {" "}
                    to create your first interval
                  </p>
                </>
              )
            : <p className="m-0">No intervals match your filters</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-auto">
        <Table>
          <TableBody>
            {rows.map(row => (
              <TableRow key={row.id} className="group">
                {row.getVisibleCells().map(cell => (
                  <TableCell
                    key={cell.id}
                    className={cell.column.id === "title" ? "w-full" : "w-8"}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
