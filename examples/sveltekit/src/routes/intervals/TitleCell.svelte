<script lang="ts">
	import type { Interval } from "$collections/useIntervals";

	type Props = { interval: Interval };
	const { interval }: Props = $props();
</script>

<a href="/intervals/{interval.id}" class="block no-underline text-foreground hover:text-primary transition-fast">
	<span class="text-sm font-medium truncate">{interval.title || "Untitled"}</span>
</a>
