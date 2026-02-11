import { Link } from '@tanstack/react-router';
import { Search, SlidersHorizontal, Plus, Menu } from 'lucide-react';
import { Button } from './ui/button';
import { BrandIcon } from './BrandIcon';
import { cn } from '@/lib/utils';

interface NavbarProps {
	onSearchOpen: () => void;
	onFilterOpen: () => void;
	onCreate: () => void;
	onMenuOpen?: () => void;
	hasActiveFilters?: boolean;
}

export function Navbar({
	onSearchOpen,
	onFilterOpen,
	onCreate,
	onMenuOpen,
	hasActiveFilters = false,
}: NavbarProps) {
	return (
		<nav className="navbar">
			{/* Left: Brand */}
			<div className="flex items-center gap-3">
				{/* Mobile menu button */}
				<Button
					variant="ghost"
					size="icon-sm"
					className="md:hidden"
					onClick={onMenuOpen}
					aria-label="Open menu"
				>
					<Menu className="h-4 w-4" />
				</Button>

				<Link to="/intervals" className="navbar-brand">
					<BrandIcon className="navbar-brand-icon" />
					<span>INTERVAL</span>
				</Link>
			</div>

			{/* Center: Search trigger */}
			<div className="navbar-center hidden sm:flex">
				<button type="button" className="search-trigger" onClick={onSearchOpen}>
					<Search className="h-4 w-4" />
					<span>Search intervals...</span>
					<kbd>&#x2318;K</kbd>
				</button>
			</div>

			{/* Right: Actions */}
			<div className="navbar-actions">
				{/* Mobile search */}
				<Button
					variant="ghost"
					size="icon-sm"
					className="sm:hidden"
					onClick={onSearchOpen}
					aria-label="Search"
				>
					<Search className="h-4 w-4" />
				</Button>

				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onFilterOpen}
					aria-label="Filter intervals"
					className={cn(hasActiveFilters && 'text-primary')}
				>
					<SlidersHorizontal className="h-4 w-4" />
				</Button>

				<Button variant="ghost" size="icon-sm" onClick={onCreate} aria-label="Create interval">
					<Plus className="h-4 w-4" />
				</Button>
			</div>
		</nav>
	);
}
