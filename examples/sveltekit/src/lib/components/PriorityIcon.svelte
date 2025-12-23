<script lang="ts">
	import { Priority, PriorityLabels } from '$lib/types';
	import type { PriorityValue } from '$lib/types';
	import { cn } from '$lib/utils';

	type Props = {
		priority: PriorityValue;
		size?: number;
		class?: string;
	};

	const { priority, size = 14, class: className = '' }: Props = $props();

	const priorityColors: Record<PriorityValue, string> = {
		none: 'currentColor',
		low: 'currentColor',
		medium: '#f59e0b', // amber-500
		high: '#f97316', // orange-500
		urgent: '#ef4444' // red-500
	};

	const color = $derived(priorityColors[priority]);
	const label = $derived(PriorityLabels[priority]);

	// Number of filled bars based on priority
	const filledBars = $derived(
		priority === 'urgent' ? 4 : priority === 'high' ? 3 : priority === 'medium' ? 2 : priority === 'low' ? 1 : 0
	);

	const containerSize = $derived(size + 6);
</script>

<div
	class={cn('inline-flex items-center justify-center rounded-sm bg-border', className)}
	style="width: {containerSize}px; height: {containerSize}px;"
>
	<svg width={size} height={size} viewBox="0 0 16 16" fill="none" role="img" aria-label={label}>
		<title>{label}</title>
		<!-- 4 vertical bars -->
		{#each [0, 1, 2, 3] as i}
			<rect
				x={1 + i * 4}
				y={12 - (i + 1) * 2.5}
				width={3}
				height={(i + 1) * 2.5}
				rx={0.5}
				fill={i < filledBars ? color : 'var(--border)'}
			/>
		{/each}
	</svg>
</div>
