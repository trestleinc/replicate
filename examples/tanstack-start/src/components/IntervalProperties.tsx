import {
  Status,
  Priority,
  StatusLabels,
  PriorityLabels,
  type StatusValue,
  type PriorityValue,
  type Interval,
} from "../types/interval";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";

interface IntervalPropertiesProps {
  interval: Interval;
  onUpdate: (updates: Partial<Pick<Interval, "status" | "priority">>) => void;
}

export function IntervalProperties({ interval, onUpdate }: IntervalPropertiesProps) {
  const statusOptions = Object.values(Status) as StatusValue[];
  const priorityOptions = Object.values(Priority) as PriorityValue[];

  const createdDate = new Date(interval.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="p-4 space-y-4">
      <h3 className="font-display text-sm font-normal text-muted-foreground uppercase tracking-wide">
        Properties
      </h3>

      {/* Status property */}
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Status</span>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-left rounded-sm hover:bg-muted transition-colors">
            <StatusIcon status={interval.status} size={14} />
            <span>{StatusLabels[interval.status]}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={interval.status}
              onValueChange={v => onUpdate({ status: v as StatusValue })}
            >
              {statusOptions.map(status => (
                <DropdownMenuRadioItem key={status} value={status}>
                  <StatusIcon status={status} size={14} />
                  {StatusLabels[status]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Priority property */}
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Priority</span>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-left rounded-sm hover:bg-muted transition-colors">
            <PriorityIcon priority={interval.priority} size={14} />
            <span>{PriorityLabels[interval.priority]}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={interval.priority}
              onValueChange={v => onUpdate({ priority: v as PriorityValue })}
            >
              {priorityOptions.map(priority => (
                <DropdownMenuRadioItem key={priority} value={priority}>
                  <PriorityIcon priority={priority} size={14} />
                  {PriorityLabels[priority]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Created date */}
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Created</span>
        <span className="block text-sm text-foreground">{createdDate}</span>
      </div>
    </div>
  );
}
