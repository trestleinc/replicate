<script lang="ts">
	type Props = {
		size?: number;
		class?: string;
		animate?: boolean;
	};

	const { size = 24, class: className = '', animate = false }: Props = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 32 32"
	class="star-icon {animate ? 'star-icon-animate' : ''} {className}"
	aria-hidden="true"
>
	<title>Notebook star icon</title>
	<!-- 8-pointed star: two hollow frame wireframes -->
	<g stroke="currentColor" stroke-width="1.5" fill="none">
		<!-- Frame 1: Standard orientation -->
		<rect x="5" y="5" width="22" height="22" />
		<rect x="8" y="8" width="16" height="16" />
		<line x1="5" y1="5" x2="8" y2="8" />
		<line x1="27" y1="5" x2="24" y2="8" />
		<line x1="27" y1="27" x2="24" y2="24" />
		<line x1="5" y1="27" x2="8" y2="24" />
		<!-- Frame 2: Rotated 45° -->
		<g transform="rotate(45 16 16)">
			<rect x="5" y="5" width="22" height="22" />
			<rect x="8" y="8" width="16" height="16" />
			<line x1="5" y1="5" x2="8" y2="8" />
			<line x1="27" y1="5" x2="24" y2="8" />
			<line x1="27" y1="27" x2="24" y2="24" />
			<line x1="5" y1="27" x2="8" y2="24" />
		</g>
	</g>
</svg>
