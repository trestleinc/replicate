import { useState, useEffect } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusIcon } from './StatusIcon';
import { PriorityIcon } from './PriorityIcon';
import { cn } from '@/lib/utils';
import {
	Status,
	Priority,
	StatusLabels,
	PriorityLabels,
	type StatusValue,
	type PriorityValue,
} from '../types/interval';

interface FilterDialogProps {
	isOpen: boolean;
	onClose: () => void;
	statusFilter: StatusValue | null;
	priorityFilter: PriorityValue | null;
	onStatusChange: (status: StatusValue | null) => void;
	onPriorityChange: (priority: PriorityValue | null) => void;
}

export function FilterDialog({
	isOpen,
	onClose,
	statusFilter,
	priorityFilter,
	onStatusChange,
	onPriorityChange,
}: FilterDialogProps) {
	const [selectedSection, setSelectedSection] = useState<'status' | 'priority'>('status');
	const [selectedIndex, setSelectedIndex] = useState(0);

	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];

	const hasFilters = statusFilter !== null || priorityFilter !== null;

	// Reset state when opened
	useEffect(() => {
		if (isOpen) {
			setSelectedSection('status');
			setSelectedIndex(0);
		}
	}, [isOpen]);

	// Handle keyboard navigation
	const handleKeyDown = (e: React.KeyboardEvent) => {
		const currentOptions = selectedSection === 'status' ? statusOptions : priorityOptions;
		const optionsCount = currentOptions.length + 1; // +1 for "All" option

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, optionsCount - 1));
				break;
			case 'ArrowUp':
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
				break;
			case 'Tab':
				e.preventDefault();
				setSelectedSection((s) => (s === 'status' ? 'priority' : 'status'));
				setSelectedIndex(0);
				break;
			case 'Enter':
				e.preventDefault();
				if (selectedSection === 'status') {
					if (selectedIndex === 0) {
						onStatusChange(null);
					} else {
						onStatusChange(statusOptions[selectedIndex - 1]);
					}
				} else {
					if (selectedIndex === 0) {
						onPriorityChange(null);
					} else {
						onPriorityChange(priorityOptions[selectedIndex - 1]);
					}
				}
				break;
		}
	};

	const handleClearFilters = () => {
		onStatusChange(null);
		onPriorityChange(null);
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				className="h-auto max-h-[80vh] w-[85vw] max-w-[85vw] gap-0 rounded-none p-0 sm:max-h-[85vh] sm:max-w-[400px]"
				showCloseButton={false}
				onKeyDown={handleKeyDown}
			>
				<DialogHeader className="sr-only">
					<DialogTitle>Filter intervals</DialogTitle>
				</DialogHeader>

				{/* Header */}
				<div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
					<div className="flex items-center gap-2">
						<SlidersHorizontal className="text-muted-foreground h-4 w-4 shrink-0" />
						<span className="text-sm font-medium">Filters</span>
					</div>
					<div className="flex items-center gap-2">
						{hasFilters && (
							<Button
								variant="ghost"
								size="sm"
								onClick={handleClearFilters}
								className="text-muted-foreground h-7 px-2"
							>
								Clear all
							</Button>
						)}
						{/* Mobile close button */}
						<button
							type="button"
							onClick={onClose}
							className="text-muted-foreground hover:text-foreground text-sm sm:hidden"
						>
							Done
						</button>
					</div>
				</div>

				{/* Filter Sections */}
				<ScrollArea className="flex-1 sm:max-h-[400px]">
					<div className="p-1">
						{/* Status Section */}
						<div className="mb-2">
							<div className="text-muted-foreground px-3 py-1.5 text-xs font-medium tracking-wider uppercase">
								Status
							</div>
							{/* All statuses option */}
							<FilterOption
								label="All statuses"
								isSelected={statusFilter === null}
								isFocused={selectedSection === 'status' && selectedIndex === 0}
								onClick={() => onStatusChange(null)}
								onMouseEnter={() => {
									setSelectedSection('status');
									setSelectedIndex(0);
								}}
							/>
							{statusOptions.map((status, index) => (
								<FilterOption
									key={status}
									label={StatusLabels[status]}
									icon={<StatusIcon status={status} size={14} />}
									isSelected={statusFilter === status}
									isFocused={selectedSection === 'status' && selectedIndex === index + 1}
									onClick={() => onStatusChange(status)}
									onMouseEnter={() => {
										setSelectedSection('status');
										setSelectedIndex(index + 1);
									}}
								/>
							))}
						</div>

						{/* Divider */}
						<div className="bg-border my-2 h-px" />

						{/* Priority Section */}
						<div>
							<div className="text-muted-foreground px-3 py-1.5 text-xs font-medium tracking-wider uppercase">
								Priority
							</div>
							{/* All priorities option */}
							<FilterOption
								label="All priorities"
								isSelected={priorityFilter === null}
								isFocused={selectedSection === 'priority' && selectedIndex === 0}
								onClick={() => onPriorityChange(null)}
								onMouseEnter={() => {
									setSelectedSection('priority');
									setSelectedIndex(0);
								}}
							/>
							{priorityOptions.map((priority, index) => (
								<FilterOption
									key={priority}
									label={PriorityLabels[priority]}
									icon={<PriorityIcon priority={priority} size={14} />}
									isSelected={priorityFilter === priority}
									isFocused={selectedSection === 'priority' && selectedIndex === index + 1}
									onClick={() => onPriorityChange(priority)}
									onMouseEnter={() => {
										setSelectedSection('priority');
										setSelectedIndex(index + 1);
									}}
								/>
							))}
						</div>
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
							tab
						</kbd>{' '}
						switch section
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
	);
}

interface FilterOptionProps {
	label: string;
	icon?: React.ReactNode;
	isSelected: boolean;
	isFocused: boolean;
	onClick: () => void;
	onMouseEnter: () => void;
}

function FilterOption({
	label,
	icon,
	isSelected,
	isFocused,
	onClick,
	onMouseEnter,
}: FilterOptionProps) {
	return (
		<div
			role="option"
			aria-selected={isSelected}
			tabIndex={0}
			className={cn(
				'flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left',
				'hover:bg-muted hover:text-foreground border-l-2 border-transparent transition-colors',
				isFocused && 'bg-muted text-foreground border-sidebar-accent border-l-2',
				isSelected && !isFocused && 'text-primary'
			)}
			onClick={onClick}
			onMouseEnter={onMouseEnter}
			onKeyDown={(e) => e.key === 'Enter' && onClick()}
		>
			{icon && <span className="shrink-0">{icon}</span>}
			<span className="text-sm">{label}</span>
			{isSelected && (
				<span className="ml-auto">
					<X className="text-muted-foreground h-3.5 w-3.5" />
				</span>
			)}
		</div>
	);
}
