<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Interval } from '$collections/useIntervals';

	type Props = { interval: Interval };
	const { interval }: Props = $props();
</script>

<a
	href={resolve(`/intervals/${interval.id}`)}
	class="text-foreground hover:text-primary transition-fast block no-underline"
>
	<span class="truncate text-sm font-medium">{interval.title || 'Untitled'}</span>
</a>
