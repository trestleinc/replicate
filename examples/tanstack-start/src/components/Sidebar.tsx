import { Link, useParams, ClientOnly } from "@tanstack/react-router";
import { Plus, Search, SlidersHorizontal } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useIntervalsContext } from "../contexts/IntervalsContext";
import { useCreateInterval } from "../hooks/useCreateInterval";
import { StarIcon } from "./StarIcon";
import { StatusIcon } from "./StatusIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Interval } from "../types/interval";

interface SidebarProps {
	onSearchOpen: () => void;
	onFilterOpen: () => void;
	hasActiveFilters?: boolean;
}

export function Sidebar({ onSearchOpen, onFilterOpen, hasActiveFilters }: SidebarProps) {
	// Server-render the sidebar shell, client-only for intervals list
	return (
		<aside className="hidden md:flex w-[var(--sidebar-width)] min-w-[var(--sidebar-width)] h-dvh flex-col bg-sidebar overflow-hidden">
			{/* Header - server-rendered */}
			<div className="flex items-center justify-between px-3 py-3 border-b border-sidebar-border">
				<Link
					to="/intervals"
					className="flex items-center gap-2 font-display text-base font-normal text-sidebar-foreground no-underline"
				>
					<StarIcon size={18} />
					<span>Interval</span>
				</Link>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onSearchOpen}
						aria-label="Search intervals"
					>
						<Search className="w-4 h-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onFilterOpen}
						aria-label="Filter intervals"
						className={cn(hasActiveFilters && "text-primary")}
					>
						<SlidersHorizontal className="w-4 h-4" />
					</Button>
				</div>
			</div>

			{/* New Interval Button - server-rendered shell, client for action */}
			<div className="p-2">
				<ClientOnly fallback={<NewIntervalButtonFallback />}>
					<NewIntervalButton />
				</ClientOnly>
			</div>

			{/* Navigation - client-only (needs real-time data) */}
			<ScrollArea className="flex-1">
				<nav className="p-1">
					<ClientOnly fallback={<SidebarSkeleton />}>
						<SidebarIntervalsList />
					</ClientOnly>
				</nav>
			</ScrollArea>
		</aside>
	);
}

function NewIntervalButtonFallback() {
	return (
		<Button variant="outline" className="w-full justify-start gap-2" disabled>
			<Plus className="w-4 h-4" />
			<span>New Interval</span>
		</Button>
	);
}

function NewIntervalButton() {
	const createInterval = useCreateInterval();

	return (
		<Button variant="outline" className="w-full justify-start gap-2" onClick={createInterval}>
			<Plus className="w-4 h-4" />
			<span>New Interval</span>
		</Button>
	);
}

function SidebarSkeleton() {
	return (
		<div className="space-y-2 p-2">
			<Skeleton className="h-8 w-full" />
			<Skeleton className="h-8 w-3/4" />
			<Skeleton className="h-8 w-4/5" />
		</div>
	);
}

function SidebarIntervalsList() {
	const { collection, intervals, isLoading } = useIntervalsContext();
	const params = useParams({ strict: false });
	const activeId = (params as { intervalId?: string }).intervalId;

	const [editingId, setEditingId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	// Filter out items without valid ids and sort by updatedAt descending
	const sortedIntervals = [...intervals]
		.filter((i): i is Interval => typeof i.id === "string" && i.id.length > 0)
		.sort((a, b) => b.updatedAt - a.updatedAt);

	const handleStartRename = (id: string) => {
		const interval = intervals.find(i => i.id === id);
		if (interval) {
			setEditingId(id);
			setEditTitle(interval.title);
		}
	};

	const handleSaveRename = (id: string) => {
		if (editTitle.trim()) {
			collection.update(id, (draft: Interval) => {
				draft.title = editTitle.trim();
				draft.updatedAt = Date.now();
			});
		}
		setEditingId(null);
	};

	// Focus edit input when editing
	useEffect(() => {
		if (editingId && editInputRef.current) {
			editInputRef.current.focus();
			editInputRef.current.select();
		}
	}, [editingId]);

	if (isLoading) {
		return <SidebarSkeleton />;
	}

	if (sortedIntervals.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-8 px-3 text-muted-foreground text-center text-sm">
				<StatusIcon status="backlog" size={24} className="mb-2 opacity-30" />
				<p className="m-0">No intervals yet</p>
				<p className="m-0 text-xs opacity-60">Create your first interval</p>
			</div>
		);
	}

	return (
		<ul className="list-none m-0 p-0 flex flex-col">
			{sortedIntervals.map(interval => (
				<li key={interval.id}>
					{editingId === interval.id ? (
						<div className="flex items-center gap-2 px-3 py-2 bg-muted">
							<StatusIcon status={interval.status} size={14} className="shrink-0" />
							<Input
								ref={editInputRef}
								type="text"
								value={editTitle}
								onChange={e => setEditTitle(e.target.value)}
								onBlur={() => handleSaveRename(interval.id)}
								onKeyDown={e => {
									if (e.key === "Enter") handleSaveRename(interval.id);
									if (e.key === "Escape") setEditingId(null);
								}}
								className="flex-1 h-6 text-sm p-1"
							/>
						</div>
					) : (
						<Link
							to="/intervals/$intervalId"
							params={{ intervalId: interval.id }}
							className={cn(
								"group flex items-center gap-2 px-3 py-2 text-sm no-underline transition-colors",
								activeId === interval.id
									? "bg-muted text-foreground border-l-2 border-sidebar-accent"
									: "text-muted-foreground hover:bg-muted hover:text-foreground border-l-2 border-transparent",
							)}
						>
							<StatusIcon status={interval.status} size={14} className="shrink-0" />
							<button
								type="button"
								className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left bg-transparent border-none p-0 font-inherit text-inherit cursor-pointer"
								onDoubleClick={e => {
									e.preventDefault();
									e.stopPropagation();
									handleStartRename(interval.id);
								}}
							>
								{interval.title || "Untitled"}
							</button>
						</Link>
					)}
				</li>
			))}
		</ul>
	);
}
