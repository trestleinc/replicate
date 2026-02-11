import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Search, Plus, Trash2 } from 'lucide-react';
import { schema } from '@trestleinc/replicate/client';
import { useIntervalsContext } from '../contexts/IntervalsContext';
import { useCreateInterval } from '../hooks/useCreateInterval';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogCancel,
	AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';

interface SearchPanelProps {
	isOpen: boolean;
	onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 150;

export function SearchPanel({ isOpen, onClose }: SearchPanelProps) {
	const [query, setQuery] = useState('');
	const [debouncedQuery, setDebouncedQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const navigate = useNavigate();
	const createInterval = useCreateInterval();

	const { collection, intervals } = useIntervalsContext();

	// Debounce search query
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedQuery(query);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);

	// Memoize text extraction per interval
	const intervalsWithText = useMemo(
		() =>
			intervals.map((i) => ({
				...i,
				textContent: schema.prose.extract(i.description).toLowerCase(),
			})),
		[intervals]
	);

	// Filter locally - show recent intervals when empty (Raycast-style)
	const results = useMemo(() => {
		const sorted = [...intervalsWithText].sort((a, b) => b.updatedAt - a.updatedAt);

		if (!debouncedQuery.trim()) {
			return sorted.slice(0, 10); // Show recent 10 when empty
		}

		const q = debouncedQuery.toLowerCase();
		return sorted
			.filter((i) => i.title?.toLowerCase().includes(q) || i.textContent.includes(q))
			.slice(0, 20);
	}, [intervalsWithText, debouncedQuery]);

	// Reset state when opened
	useEffect(() => {
		if (isOpen) {
			setQuery('');
			setDebouncedQuery('');
			setSelectedIndex(0);
			// Focus input after dialog animation
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	}, [isOpen]);

	// Reset selection when results change
	useEffect(() => {
		if (results.length > 0 && selectedIndex >= results.length) {
			setSelectedIndex(0);
		}
	}, [results.length, selectedIndex]);

	// Handle creating new interval
	const handleCreateInterval = () => {
		createInterval();
		onClose();
	};

	// Handle keyboard navigation (index -1 = New Interval action)
	const handleKeyDown = (e: React.KeyboardEvent) => {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
				break;
			case 'ArrowUp':
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, -1));
				break;
			case 'Enter':
				e.preventDefault();
				if (selectedIndex === -1) {
					handleCreateInterval();
				} else if (results[selectedIndex]) {
					handleSelect(results[selectedIndex].id);
				}
				break;
		}
	};

	const handleSelect = (id: string) => {
		navigate({ to: '/intervals/$intervalId', params: { intervalId: id } });
		onClose();
	};

	const handleDeleteClick = (e: React.MouseEvent, id: string) => {
		e.stopPropagation();
		setDeleteConfirmId(id);
	};

	const handleConfirmDelete = () => {
		if (deleteConfirmId) {
			collection.delete(deleteConfirmId);
			setDeleteConfirmId(null);
			// Navigate away if we deleted the current interval
			navigate({ to: '/intervals' });
		}
	};

	const intervalToDelete = deleteConfirmId ? intervals.find((i) => i.id === deleteConfirmId) : null;

	return (
		<>
			<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
				<DialogContent
					className="h-auto max-h-[80vh] w-[85vw] max-w-[85vw] gap-0 rounded-none p-0 sm:max-h-[85vh] sm:max-w-[520px]"
					showCloseButton={false}
				>
					<DialogHeader className="sr-only">
						<DialogTitle>Search intervals</DialogTitle>
					</DialogHeader>

					{/* Search Input */}
					<div className="border-border flex items-center gap-3 border-b px-4 py-3">
						<Search className="text-muted-foreground h-4 w-4 shrink-0" />
						<Input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Search intervals..."
							className="h-auto border-0 p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
						/>
						{/* Mobile close button */}
						<button
							type="button"
							onClick={onClose}
							className="text-muted-foreground hover:text-foreground text-sm sm:hidden"
						>
							Cancel
						</button>
					</div>

					{/* Results */}
					<ScrollArea className="flex-1 sm:max-h-[400px]">
						<div className="p-1">
							{/* New Interval action */}
							<div
								role="option"
								tabIndex={0}
								className={cn(
									'flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left',
									'hover:bg-muted hover:text-foreground border-l-2 border-transparent transition-colors',
									selectedIndex === -1 &&
										'bg-muted text-foreground border-sidebar-accent border-l-2'
								)}
								onClick={handleCreateInterval}
								onMouseEnter={() => setSelectedIndex(-1)}
								onKeyDown={(e) => e.key === 'Enter' && handleCreateInterval()}
							>
								<Plus className="text-primary h-4 w-4 shrink-0" />
								<span className="text-sm font-medium">New Interval</span>
								<span className="text-muted-foreground ml-auto text-xs">⌥N</span>
							</div>

							{/* Divider */}
							{results.length > 0 && <div className="bg-border my-1 h-px" />}

							{/* Interval results */}
							{results.length === 0 && debouncedQuery.trim() ? (
								<div className="text-muted-foreground py-6 text-center text-sm">
									<p>No intervals found for &ldquo;{query}&rdquo;</p>
								</div>
							) : (
								results.map((interval, index) => (
									<div
										key={interval.id}
										role="option"
										tabIndex={0}
										className={cn(
											'group flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left',
											'hover:bg-muted hover:text-foreground border-l-2 border-transparent transition-colors',
											index === selectedIndex &&
												'bg-muted text-foreground border-sidebar-accent border-l-2'
										)}
										onClick={() => handleSelect(interval.id)}
										onMouseEnter={() => setSelectedIndex(index)}
										onKeyDown={(e) => e.key === 'Enter' && handleSelect(interval.id)}
									>
										<StatusIcon status={interval.status} size={14} className="shrink-0" />
										<span className="min-w-0 flex-1 truncate text-sm font-medium">
											{interval.title || 'Untitled'}
										</span>
										<Button
											variant="ghost"
											size="icon-xs"
											onClick={(e) => handleDeleteClick(e, interval.id)}
											className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
											title="Delete interval"
										>
											<Trash2 className="h-3.5 w-3.5" />
										</Button>
									</div>
								))
							)}

							{/* Empty state hint */}
							{results.length === 0 && !debouncedQuery.trim() && (
								<div className="text-muted-foreground py-6 text-center text-sm">
									<p>No intervals yet</p>
									<p className="mt-1 text-xs">Create your first interval above</p>
								</div>
							)}
						</div>
					</ScrollArea>

					{/* Keyboard hints */}
					<div className="border-border text-muted-foreground hidden items-center justify-center gap-4 border-t px-4 py-2 text-xs sm:flex">
						<span>
							<kbd className="bg-background border-border mx-0.5 rounded-sm border px-1.5 py-0.5 font-mono text-[0.6875rem]">
								↑↓
							</kbd>{' '}
							navigate
						</span>
						<span>
							<kbd className="bg-background border-border mx-0.5 rounded-sm border px-1.5 py-0.5 font-mono text-[0.6875rem]">
								↵
							</kbd>{' '}
							select
						</span>
						<span>
							<kbd className="bg-background border-border mx-0.5 rounded-sm border px-1.5 py-0.5 font-mono text-[0.6875rem]">
								esc
							</kbd>{' '}
							close
						</span>
					</div>
				</DialogContent>
			</Dialog>

			{/* Delete confirmation dialog */}
			<AlertDialog
				open={!!deleteConfirmId}
				onOpenChange={(open) => !open && setDeleteConfirmId(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete interval?</AlertDialogTitle>
						<AlertDialogDescription>
							{intervalToDelete
								? `"${intervalToDelete.title || 'Untitled'}" will be permanently deleted. This action cannot be undone.`
								: 'This action cannot be undone.'}
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
