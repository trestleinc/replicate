import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { prose } from "@trestleinc/replicate/client";
import { useIntervalsContext } from "../contexts/IntervalsContext";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Button } from "./ui/button";
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
import { Status, Priority, StatusLabels, PriorityLabels, type StatusValue, type PriorityValue } from "../types/interval";
import type { Interval } from "../types/interval";

interface IntervalRowProps {
  interval: Interval;
}

export function IntervalRow({ interval }: IntervalRowProps) {
  const { collection } = useIntervalsContext();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const description = prose.extract(interval.description);
  const preview = description.slice(0, 100) + (description.length > 100 ? "..." : "");

  const statusOptions = Object.values(Status) as StatusValue[];
  const priorityOptions = Object.values(Priority) as PriorityValue[];

  const handleStatusChange = (newStatus: string) => {
    collection.update(interval.id, (draft: Interval) => {
      draft.status = newStatus as StatusValue;
      // Don't update updatedAt to prevent re-sorting
    });
  };

  const handlePriorityChange = (newPriority: string) => {
    collection.update(interval.id, (draft: Interval) => {
      draft.priority = newPriority as PriorityValue;
      // Don't update updatedAt to prevent re-sorting
    });
  };

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
      <div className="group flex items-center gap-3 px-6 py-3 border-b border-border transition-colors hover:bg-muted">
        {/* Status dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center rounded-sm hover:bg-muted transition-colors shrink-0">
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

        {/* Title and preview - clickable link */}
        <Link
          to="/intervals/$intervalId"
          params={{ intervalId: interval.id }}
          className="flex-1 min-w-0 flex flex-col gap-0.5 no-underline text-foreground"
        >
          <span className="text-sm font-medium truncate">{interval.title || "Untitled"}</span>
          {preview && <span className="text-xs text-muted-foreground truncate">{preview}</span>}
        </Link>

        {/* Priority dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center rounded-sm hover:bg-muted transition-colors shrink-0">
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

        {/* Delete button */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleDeleteClick}
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
          title="Delete interval"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete interval?</AlertDialogTitle>
            <AlertDialogDescription>
              "
              {interval.title || "Untitled"}
              " will be permanently deleted. This action cannot be undone.
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
