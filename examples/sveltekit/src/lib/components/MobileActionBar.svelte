<script lang="ts">
	import { goto } from "$app/navigation";
	import { Search, Plus, SlidersHorizontal } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import { cn } from "$lib/utils";
	import { getIntervalsContext } from "$lib/contexts/intervals.svelte";
	import { schema } from "@trestleinc/replicate/client";

	type Props = {
		onsearchopen: () => void;
		onfilteropen: () => void;
		hasActiveFilters?: boolean;
	};

	const { onsearchopen, onfilteropen, hasActiveFilters = false }: Props = $props();

	// Get collection from context for mutations
	const intervalsCtx = getIntervalsContext();

	function createInterval() {
		const id = crypto.randomUUID();
		const now = Date.now();
		intervalsCtx.collection.insert({
			id,
			isPublic: true,
			title: "New Interval",
			description: schema.prose.empty(),
			status: "backlog",
			priority: "none",
			createdAt: now,
			updatedAt: now,
		});
		goto(`/intervals/${id}`);
	}
</script>

<!-- Right Island: Actions (Search, Filter, Create) -->
<div class="floating-island floating-island-actions">
	<div class="flex items-center gap-1 p-1">
		<Button variant="ghost" size="icon" onclick={onsearchopen} aria-label="Search intervals" class="h-10 w-10">
			<Search class="w-5 h-5" />
		</Button>
		<div class="w-px h-6 bg-border"></div>
		<Button
			variant="ghost"
			size="icon"
			onclick={onfilteropen}
			aria-label="Filter intervals"
			class={cn("h-10 w-10", hasActiveFilters && "text-primary")}
		>
			<SlidersHorizontal class="w-5 h-5" />
		</Button>
		<div class="w-px h-6 bg-border"></div>
		<Button variant="ghost" size="icon" onclick={createInterval} aria-label="New interval" class="h-10 w-10">
			<Plus class="w-5 h-5" />
		</Button>
	</div>
</div>
