/// <reference types="vite/client" />
import { TanStackDevtools } from '@tanstack/react-devtools';
import type { QueryClient } from '@tanstack/react-query';
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
	ClientOnly,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { createServerFn } from '@tanstack/react-start';
import { configure, getConsoleSink, type LogRecord } from '@logtape/logtape';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { ConvexHttpClient } from 'convex/browser';
import { useState, useEffect, createContext, useContext } from 'react';
import { ArrowLeft, Search, Plus, SlidersHorizontal } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../components/ui/button';
import { ConvexRxErrorBoundary } from '../components/ErrorBoundary';
import { ReloadPrompt } from '../components/ReloadPrompt';
import { Navbar } from '../components/Navbar';
import { Sidebar } from '../components/Sidebar';
import { SearchPanel } from '../components/SearchPanel';
import { FilterDialog } from '../components/FilterDialog';
import { IntervalsProvider } from '../contexts/IntervalsContext';
import { useCreateInterval } from '../hooks/useCreateInterval';
import { cn } from '@/lib/utils';
import type { StatusValue, PriorityValue } from '../types/interval';
import { api } from '$convex/_generated/api';

import appCss from '../styles.css?url';

try {
	await configure({
		sinks: {
			console: getConsoleSink({
				formatter(record: LogRecord): readonly unknown[] {
					let msg = '';
					const values: unknown[] = [];
					for (let i = 0; i < record.message.length; i++) {
						if (i % 2 === 0) msg += String(record.message[i]);
						else {
							msg += '%o';
							values.push(record.message[i]);
						}
					}

					const hasProperties = Object.keys(record.properties).length > 0;
					const propsMsg = hasProperties ? ' | Props: %o' : '';

					return [
						`${record.level.toUpperCase()} %c${record.category.join('·')}%c ${msg}${propsMsg}`,
						'color: gray;',
						'color: default;',
						...values,
						...(hasProperties ? [record.properties] : []),
					];
				},
			}),
		},
		loggers: [{ category: ['convex-replicate'], lowestLevel: 'debug', sinks: ['console'] }],
	});
} catch {
	// LogTape already configured during HMR - this is expected
}

// Create Convex client for React context (client-only, guarded for SSR module eval)
let convexReactClient: ConvexReactClient | null = null;
if (typeof window !== 'undefined') {
	const convexUrl = import.meta.env.PUBLIC_CONVEX_URL;
	if (convexUrl) {
		convexReactClient = new ConvexReactClient(convexUrl);
	}
}

// Server function to fetch initial material for SSR hydration
const fetchMaterial = createServerFn({ method: 'GET' }).handler(async () => {
	const url = process.env.PUBLIC_CONVEX_URL;
	if (!url) {
		return { intervalsMaterial: null, commentsMaterial: null };
	}
	const httpClient = new ConvexHttpClient(url);
	try {
		const [intervalsMaterial, commentsMaterial] = await Promise.all([
			httpClient.query(api.intervals.material),
			httpClient.query(api.comments.material),
		]);
		return { intervalsMaterial, commentsMaterial };
	} catch (error) {
		console.error('Failed to load initial data from Convex:', error);
		return { intervalsMaterial: null, commentsMaterial: null };
	}
});

// Filter context for sharing filter state across components
interface FilterContextValue {
	statusFilter: StatusValue | null;
	priorityFilter: PriorityValue | null;
	setStatusFilter: (status: StatusValue | null) => void;
	setPriorityFilter: (priority: PriorityValue | null) => void;
	hasActiveFilters: boolean;
}

const FilterContext = createContext<FilterContextValue | null>(null);

export function useFilterContext() {
	const ctx = useContext(FilterContext);
	if (!ctx) {
		// Return default values for SSR
		return {
			statusFilter: null,
			priorityFilter: null,
			setStatusFilter: (_: StatusValue | null) => {
				/* noop */
			},
			setPriorityFilter: (_: PriorityValue | null) => {
				/* noop */
			},
			hasActiveFilters: false,
		};
	}
	return ctx;
}

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	head: () => ({
		meta: [
			{ charSet: 'utf-8' },
			{ name: 'viewport', content: 'width=device-width, initial-scale=1' },
			{ title: 'Interval' },
			{ name: 'description', content: 'Offline-first interval tracker with real-time sync' },
			// Open Graph
			{ property: 'og:title', content: 'Interval' },
			{ property: 'og:description', content: 'Offline-first interval tracker with real-time sync' },
			{ property: 'og:image', content: '/logo512.png' },
			{ property: 'og:type', content: 'website' },
			// Twitter
			{ name: 'twitter:card', content: 'summary' },
			{ name: 'twitter:title', content: 'Interval' },
			{
				name: 'twitter:description',
				content: 'Offline-first interval tracker with real-time sync',
			},
			{ name: 'twitter:image', content: '/logo512.png' },
		],
		links: [
			{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
			{ rel: 'apple-touch-icon', href: '/logo192.png' },
			{ rel: 'manifest', href: '/manifest.webmanifest' },
			{ rel: 'stylesheet', href: appCss },
			// Preload wa-sqlite WASM binary for faster SQLite initialization
			{
				rel: 'preload',
				href: 'https://wa-sqlite.trestle.inc/v1.0.0/dist/wa-sqlite-async.wasm',
				as: 'fetch',
				type: 'application/wasm',
				crossOrigin: 'anonymous',
			},
		],
	}),

	loader: async () => fetchMaterial(),

	component: AppLayout,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<ConvexRxErrorBoundary>
					{children}
					<TanStackDevtools
						config={{ position: 'bottom-right' }}
						plugins={[{ name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> }]}
					/>
				</ConvexRxErrorBoundary>
				<ReloadPrompt />
				<Scripts />
			</body>
		</html>
	);
}

function AppLayout() {
	const { intervalsMaterial, commentsMaterial } = Route.useLoaderData();
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const [isFilterOpen, setIsFilterOpen] = useState(false);
	const [statusFilter, setStatusFilter] = useState<StatusValue | null>(null);
	const [priorityFilter, setPriorityFilter] = useState<PriorityValue | null>(null);

	const hasActiveFilters = statusFilter !== null || priorityFilter !== null;

	const filterContextValue: FilterContextValue = {
		statusFilter,
		priorityFilter,
		setStatusFilter,
		setPriorityFilter,
		hasActiveFilters,
	};

	return (
		<ClientOnly fallback={<AppLayoutFallback />}>
			{convexReactClient ? (
				<ConvexProvider client={convexReactClient}>
					<IntervalsProvider
						intervalsMaterial={intervalsMaterial ?? undefined}
						commentsMaterial={commentsMaterial ?? undefined}
					>
						<FilterContext.Provider value={filterContextValue}>
							<div className="app-layout">
								<NavbarWithCreate
									onSearchOpen={() => setIsSearchOpen(true)}
									onFilterOpen={() => setIsFilterOpen(true)}
									hasActiveFilters={hasActiveFilters}
								/>
								<div className="app-main">
									<Sidebar />
									<main className="main-content">
										<div className="main-scroll-area">
											<Outlet />
										</div>
									</main>
								</div>
								<KeyboardShortcuts onSearchOpen={() => setIsSearchOpen(true)} />
								<SearchPanel isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
								<FilterDialog
									isOpen={isFilterOpen}
									onClose={() => setIsFilterOpen(false)}
									statusFilter={statusFilter}
									priorityFilter={priorityFilter}
									onStatusChange={setStatusFilter}
									onPriorityChange={setPriorityFilter}
								/>
								<MobileBackButton />
								<MobileActionBar
									onSearchOpen={() => setIsSearchOpen(true)}
									onFilterOpen={() => setIsFilterOpen(true)}
									hasActiveFilters={hasActiveFilters}
								/>
							</div>
						</FilterContext.Provider>
					</IntervalsProvider>
				</ConvexProvider>
			) : (
				<AppLayoutFallback />
			)}
		</ClientOnly>
	);
}

/**
 * Static layout shell for SSR (no providers, no interactivity).
 */
function AppLayoutFallback() {
	return (
		<div className="app-layout">
			<NavbarFallback />
			<div className="app-main">
				<aside className="sidebar">
					<div className="sidebar-header">
						<span className="sidebar-title">Intervals</span>
					</div>
					<div className="sidebar-content">
						<div className="space-y-1 p-2">
							{Array.from({ length: 5 }).map((_, i) => (
								<div key={i} className="skeleton h-9 w-full" />
							))}
						</div>
					</div>
				</aside>
				<main className="main-content">
					<div className="main-scroll-area" />
				</main>
			</div>
		</div>
	);
}

/**
 * Navbar with create action (needs useCreateInterval hook which requires context).
 */
function NavbarWithCreate({
	onSearchOpen,
	onFilterOpen,
	hasActiveFilters,
}: {
	onSearchOpen: () => void;
	onFilterOpen: () => void;
	hasActiveFilters: boolean;
}) {
	const createInterval = useCreateInterval();
	return (
		<Navbar
			onSearchOpen={onSearchOpen}
			onFilterOpen={onFilterOpen}
			onCreate={createInterval}
			hasActiveFilters={hasActiveFilters}
		/>
	);
}

/**
 * Static navbar shell for SSR (no actions).
 */
function NavbarFallback() {
	return (
		<nav className="navbar">
			<div className="flex items-center gap-3">
				<span className="navbar-brand">
					<span>INTERVAL</span>
				</span>
			</div>
			<div className="navbar-center hidden sm:flex">
				<button type="button" className="search-trigger" disabled>
					<span>Search intervals...</span>
				</button>
			</div>
			<div className="navbar-actions" />
		</nav>
	);
}

/**
 * Left floating island for back button (only visible on detail pages).
 */
function MobileBackButton() {
	const navigate = useNavigate();
	const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
	const isDetailPage = pathname.startsWith('/intervals/') && pathname !== '/intervals';

	if (!isDetailPage) return null;

	return (
		<div className="floating-island floating-island-back">
			<div className="p-1">
				<Button
					variant="ghost"
					size="icon"
					onClick={() => navigate({ to: '/intervals' })}
					aria-label="Back to intervals"
					className="h-10 w-10"
				>
					<ArrowLeft className="h-5 w-5" />
				</Button>
			</div>
		</div>
	);
}

/**
 * Right floating island for actions (Search, Filter, Create).
 */
function MobileActionBar({
	onSearchOpen,
	onFilterOpen,
	hasActiveFilters,
}: {
	onSearchOpen: () => void;
	onFilterOpen: () => void;
	hasActiveFilters: boolean;
}) {
	const createInterval = useCreateInterval();

	return (
		<div className="floating-island floating-island-actions">
			<div className="flex items-center gap-1 p-1">
				<Button
					variant="ghost"
					size="icon"
					onClick={onSearchOpen}
					aria-label="Search intervals"
					className="h-10 w-10"
				>
					<Search className="h-5 w-5" />
				</Button>
				<div className="bg-border h-6 w-px" />
				<Button
					variant="ghost"
					size="icon"
					onClick={onFilterOpen}
					aria-label="Filter intervals"
					className={cn('h-10 w-10', hasActiveFilters && 'text-primary')}
				>
					<SlidersHorizontal className="h-5 w-5" />
				</Button>
				<div className="bg-border h-6 w-px" />
				<Button
					variant="ghost"
					size="icon"
					onClick={createInterval}
					aria-label="New interval"
					className="h-10 w-10"
				>
					<Plus className="h-5 w-5" />
				</Button>
			</div>
		</div>
	);
}

/**
 * Client-only keyboard shortcuts component.
 * Must be inside IntervalsProvider (via ClientOnly in RootDocument).
 */
function KeyboardShortcuts({ onSearchOpen }: { onSearchOpen: () => void }) {
	const createInterval = useCreateInterval();

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't trigger shortcuts when typing in inputs/textareas
			const target = e.target as HTMLElement;
			if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
				return;
			}

			// Cmd+K or Ctrl+K: Open search
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				onSearchOpen();
			}

			// Option+N (Alt+N): Create new interval
			// Use e.code for Mac compatibility (Option key produces special chars like ñ)
			if (e.altKey && e.code === 'KeyN') {
				e.preventDefault();
				createInterval();
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onSearchOpen, createInterval]);

	return null;
}
