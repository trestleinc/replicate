import { Link, useParams, ClientOnly } from '@tanstack/react-router';
import { Globe, Lock } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useIntervalsContext } from '../contexts/IntervalsContext';
import { StatusIcon } from './StatusIcon';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Interval } from '../types/interval';

export function Sidebar() {
	return (
		<aside className="sidebar">
			{/* Header */}
			<ClientOnly
				fallback={
					<div className="sidebar-header">
						<span className="sidebar-title">Intervals</span>
					</div>
				}
			>
				<SidebarHeader />
			</ClientOnly>

			{/* Navigation - client-only (needs real-time data) */}
			<ClientOnly fallback={<SidebarSkeleton />}>
				<SidebarIntervalsList />
			</ClientOnly>
		</aside>
	);
}

function SidebarHeader() {
	const { intervals } = useIntervalsContext();
	return (
		<div className="sidebar-header">
			<span className="sidebar-title">Intervals</span>
			<span className="text-muted-foreground font-mono text-xs">{intervals.length}</span>
		</div>
	);
}

function SidebarSkeleton() {
	return (
		<div className="sidebar-content">
			<div className="space-y-1 p-2">
				{Array.from({ length: 5 }).map((_, i) => (
					<div key={i} className="skeleton h-9 w-full" />
				))}
			</div>
		</div>
	);
}

function SidebarIntervalsList() {
	const { collection, intervals, isLoading } = useIntervalsContext();
	const params = useParams({ strict: false });
	const activeId = (params as { intervalId?: string }).intervalId;

	const [editingId, setEditingId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState('');
	const editInputRef = useRef<HTMLInputElement>(null);
	const parentRef = useRef<HTMLDivElement>(null);

	// Filter and sort
	const sortedIntervals = [...intervals]
		.filter((i): i is Interval => typeof i.id === 'string' && i.id.length > 0)
		.sort((a, b) => b.updatedAt - a.updatedAt);

	// Virtualize the list
	const virtualizer = useVirtualizer({
		count: sortedIntervals.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 36,
		overscan: 15,
	});

	const handleStartRename = (id: string) => {
		const interval = intervals.find((i) => i.id === id);
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
			<div className="sidebar-content">
				<div className="text-muted-foreground flex flex-col items-center justify-center px-4 py-12 text-center text-sm">
					<StatusIcon status="backlog" size={24} className="mb-3 opacity-30" />
					<p className="m-0 font-medium">No intervals yet</p>
					<p className="m-0 mt-1 text-xs opacity-60">Press &#x2325;N to create one</p>
				</div>
			</div>
		);
	}

	return (
		<div ref={parentRef} className="sidebar-content">
			<nav className="p-1">
				<ul
					className="m-0 list-none p-0"
					style={{
						height: virtualizer.getTotalSize(),
						position: 'relative',
					}}
				>
					{virtualizer.getVirtualItems().map((virtualRow) => {
						const interval = sortedIntervals[virtualRow.index];
						return (
							<li
								key={interval.id}
								style={{
									position: 'absolute',
									top: 0,
									left: 0,
									width: '100%',
									transform: `translateY(${virtualRow.start}px)`,
								}}
							>
								{editingId === interval.id ? (
									<div className="bg-muted flex items-center gap-2 px-3 py-2">
										<StatusIcon status={interval.status} size={14} className="shrink-0" />
										<Input
											ref={editInputRef}
											type="text"
											value={editTitle}
											onChange={(e) => setEditTitle(e.target.value)}
											onBlur={() => handleSaveRename(interval.id)}
											onKeyDown={(e) => {
												if (e.key === 'Enter') handleSaveRename(interval.id);
												if (e.key === 'Escape') setEditingId(null);
											}}
											className="h-7 flex-1 p-1 text-sm"
										/>
									</div>
								) : (
									<Link
										to="/intervals/$intervalId"
										params={{ intervalId: interval.id }}
										className={cn(
											'sidebar-item',
											activeId === interval.id && 'sidebar-item-active'
										)}
									>
										<StatusIcon status={interval.status} size={14} className="shrink-0" />
										<button
											type="button"
											className="font-inherit min-w-0 flex-1 cursor-pointer overflow-hidden border-none bg-transparent p-0 text-left text-ellipsis whitespace-nowrap text-inherit"
											onDoubleClick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												handleStartRename(interval.id);
											}}
										>
											{interval.title || 'Untitled'}
										</button>
										{interval.isPublic ? (
											<Globe className="text-muted-foreground/50 h-3 w-3 shrink-0" />
										) : (
											<Lock className="text-muted-foreground/50 h-3 w-3 shrink-0" />
										)}
									</Link>
								)}
							</li>
						);
					})}
				</ul>
			</nav>
		</div>
	);
}
