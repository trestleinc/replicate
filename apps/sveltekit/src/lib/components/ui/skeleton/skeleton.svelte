<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		delayed = false,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLDivElement>>> & {
		delayed?: boolean;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="skeleton"
	class={cn('rounded-none', delayed ? 'skeleton-delayed' : 'skeleton-warm', className)}
	{...restProps}
></div>
