<script lang="ts">
	import { Status, StatusLabels } from '$lib/types';
	import type { StatusValue } from '$lib/types';

	type Props = {
		status: StatusValue;
		size?: number;
		class?: string;
	};

	const { status, size = 14, class: className = '' }: Props = $props();

	const statusColors: Record<StatusValue, string> = {
		backlog: '#6b7280', // gray-500
		todo: '#3b82f6', // blue-500
		in_progress: '#f59e0b', // amber-500
		done: '#22c55e', // green-500
		canceled: '#ef4444' // red-500
	};

	const color = $derived(statusColors[status]);
	const label = $derived(StatusLabels[status]);
	const fillOpacity = $derived(status === 'todo' ? 0.15 : 0);
</script>

{#if status === 'done'}
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		class={className}
		role="img"
		aria-label={label}
	>
		<title>{label}</title>
		<circle cx="8" cy="8" r="7" stroke={color} stroke-width="1.5" fill={color} />
		<path
			d="M5 8l2 2 4-4"
			stroke="white"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
{:else if status === 'canceled'}
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		class={className}
		role="img"
		aria-label={label}
	>
		<title>{label}</title>
		<circle cx="8" cy="8" r="7" stroke={color} stroke-width="1.5" />
		<path d="M5 8h6" stroke={color} stroke-width="1.5" stroke-linecap="round" />
	</svg>
{:else if status === 'in_progress'}
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		class={className}
		role="img"
		aria-label={label}
	>
		<title>{label}</title>
		<circle cx="8" cy="8" r="7" stroke={color} stroke-width="1.5" />
		<path d="M8 1a7 7 0 0 1 0 14" fill={color} stroke={color} stroke-width="1.5" />
	</svg>
{:else}
	<!-- Default circle for BACKLOG and TODO -->
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		class={className}
		role="img"
		aria-label={label}
	>
		<title>{label}</title>
		<circle
			cx="8"
			cy="8"
			r="7"
			stroke={color}
			stroke-width="1.5"
			fill={color}
			fill-opacity={fillOpacity}
		/>
	</svg>
{/if}
