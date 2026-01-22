<script lang="ts">
	import { Search, SlidersHorizontal, Plus, Menu } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import AuthBar from "./AuthBar.svelte";

	interface Props {
		onsearchopen?: () => void;
		onfilteropen?: () => void;
		oncreate?: () => void;
		hasActiveFilters?: boolean;
		onmenuopen?: () => void;
	}

	const {
		onsearchopen,
		onfilteropen,
		oncreate,
		hasActiveFilters = false,
		onmenuopen,
	}: Props = $props();
</script>

<nav class="navbar">
	<!-- Left: Brand -->
	<div class="flex items-center gap-3">
		<!-- Mobile menu button -->
		<Button
			variant="ghost"
			size="icon-sm"
			class="md:hidden"
			onclick={onmenuopen}
			aria-label="Open menu"
		>
			<Menu class="w-4 h-4" />
		</Button>

		<a href="/intervals" class="navbar-brand">
			<svg
				class="navbar-brand-icon"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="square"
				stroke-linejoin="miter"
			>
				<!-- Sharp geometric icon - nested squares -->
				<rect x="3" y="3" width="18" height="18" />
				<rect x="7" y="7" width="10" height="10" />
				<line x1="3" y1="3" x2="7" y2="7" />
				<line x1="21" y1="3" x2="17" y2="7" />
				<line x1="3" y1="21" x2="7" y2="17" />
				<line x1="21" y1="21" x2="17" y2="17" />
			</svg>
			<span>INTERVAL</span>
		</a>
	</div>

	<!-- Center: Search trigger -->
	<div class="navbar-center hidden sm:flex">
		<button type="button" class="search-trigger" onclick={onsearchopen}>
			<Search class="w-4 h-4" />
			<span>Search intervals...</span>
			<kbd>⌘K</kbd>
		</button>
	</div>

	<!-- Right: Actions -->
	<div class="navbar-actions">
		<!-- Mobile search -->
		<Button
			variant="ghost"
			size="icon-sm"
			class="sm:hidden"
			onclick={onsearchopen}
			aria-label="Search"
		>
			<Search class="w-4 h-4" />
		</Button>

		<Button
			variant="ghost"
			size="icon-sm"
			onclick={onfilteropen}
			aria-label="Filter intervals"
			class={hasActiveFilters ? "text-primary" : ""}
		>
			<SlidersHorizontal class="w-4 h-4" />
		</Button>

		<Button variant="ghost" size="icon-sm" onclick={oncreate} aria-label="Create interval">
			<Plus class="w-4 h-4" />
		</Button>

		<div class="hidden md:block ml-2 pl-2 border-l border-border">
			<AuthBar />
		</div>
	</div>
</nav>
