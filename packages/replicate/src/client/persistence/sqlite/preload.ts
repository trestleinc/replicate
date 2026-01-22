/**
 * CDN base URL for wa-sqlite assets.
 * Assets are served from Cloudflare's edge network with immutable caching.
 */
const CDN_BASE = 'https://wa-sqlite.trestle.inc/v1.0.0';

/**
 * wa-sqlite assets that should be preloaded for optimal performance.
 * Ordered by priority: WASM binary first (largest), then JS modules.
 */
const PRELOAD_ASSETS = [
	{ href: `${CDN_BASE}/dist/wa-sqlite-async.wasm`, as: 'fetch' as const },
	{ href: `${CDN_BASE}/dist/wa-sqlite-async.mjs`, as: 'script' as const },
	{ href: `${CDN_BASE}/src/sqlite-api.js`, as: 'script' as const },
	{ href: `${CDN_BASE}/src/examples/IDBBatchAtomicVFS.js`, as: 'script' as const },
] as const;

/**
 * Returns HTML `<link>` tags to preload wa-sqlite assets.
 * Add to your document's `<head>` to eliminate the loading waterfall
 * (page load → worker start → fetch assets).
 *
 * @example
 * ```html
 * <!-- SvelteKit: +layout.svelte -->
 * <svelte:head>
 *   {@html preloadLinks()}
 * </svelte:head>
 * ```
 *
 * @example
 * ```tsx
 * // Next.js / React: layout.tsx
 * <head dangerouslySetInnerHTML={{ __html: preloadLinks() }} />
 * ```
 */
export function preloadLinks(): string {
	return PRELOAD_ASSETS.map(({ href, as }) => {
		if (as === 'script') {
			return `<link rel="modulepreload" href="${href}" crossorigin>`;
		}
		return `<link rel="preload" href="${href}" as="${as}" crossorigin>`;
	}).join('\n');
}

/**
 * Programmatically injects preload links into the document head.
 * Call this as early as possible in your app's initialization.
 *
 * @example
 * ```ts
 * import { injectPreloadLinks } from '@trestleinc/replicate/client';
 *
 * // Call once at app startup
 * injectPreloadLinks();
 * ```
 */
export function injectPreloadLinks(): void {
	if (typeof document === 'undefined') return;

	for (const { href, as } of PRELOAD_ASSETS) {
		const link = document.createElement('link');
		link.crossOrigin = 'anonymous';

		if (as === 'script') {
			link.rel = 'modulepreload';
		} else {
			link.rel = 'preload';
			link.as = as;
		}

		link.href = href;
		document.head.appendChild(link);
	}
}
