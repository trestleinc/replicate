interface BrandIconProps {
	className?: string;
}

/**
 * Sharp geometric brand icon - nested squares with connecting lines.
 * Matches the SvelteKit app's navbar brand icon.
 */
export function BrandIcon({ className }: BrandIconProps) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="square"
			strokeLinejoin="miter"
		>
			<rect x="3" y="3" width="18" height="18" />
			<rect x="7" y="7" width="10" height="10" />
			<line x1="3" y1="3" x2="7" y2="7" />
			<line x1="21" y1="3" x2="17" y2="7" />
			<line x1="3" y1="21" x2="7" y2="17" />
			<line x1="21" y1="21" x2="17" y2="17" />
		</svg>
	);
}
