/**
 * CDN base URL for wa-sqlite assets.
 * Assets are served from Cloudflare's edge network with immutable caching.
 */
export const CDN_BASE = 'https://wa-sqlite.trestle.inc/v1.0.0';

/**
 * URL for the wa-sqlite WASM binary.
 */
export const WASM_URL = `${CDN_BASE}/dist/wa-sqlite-async.wasm`;

/**
 * Returns an HTML `<link>` tag to preload the wa-sqlite WASM binary.
 * Add to your document's `<head>` to start the network fetch before JS executes.
 *
 * The preloaded resource is consumed by {@link compileWasmModule} which calls
 * `fetch(WASM_URL)` — hitting the preload cache — and compiles via streaming.
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
export function preloadLinks(assetBase = CDN_BASE): string {
	return `<link rel="preload" href="${assetBase.replace(/\/$/, '')}/dist/wa-sqlite-async.wasm" as="fetch" type="application/wasm" crossorigin>`;
}

/**
 * Compiles the wa-sqlite WASM module using streaming compilation.
 * Uses a singleton pattern — only one fetch+compile ever happens.
 *
 * When `preloadLinks()` is in the document `<head>`, the `fetch()` call here
 * hits the browser's preload cache (no extra network request). The browser's
 * preload tracking sees the resource consumed, eliminating the
 * "preloaded but not used" warning.
 *
 * The compiled `WebAssembly.Module` is passed to the worker via `postMessage`
 * (structured clone — V8 shares compiled code internally, essentially free).
 * The worker then skips both fetch and compile, doing only instantiation.
 *
 * @returns A promise resolving to the compiled WebAssembly.Module
 */
const compiled = new Map<string, Promise<WebAssembly.Module>>();

export function compileWasmModule(assetBase = CDN_BASE): Promise<WebAssembly.Module> {
	const url = `${assetBase.replace(/\/$/, '')}/dist/wa-sqlite-async.wasm`;
	let result = compiled.get(url);
	if (!result) {
		result = WebAssembly.compileStreaming(fetch(url));
		compiled.set(url, result);
		void result.catch(() => compiled.delete(url));
	}
	return result;
}

/**
 * Programmatically injects the WASM preload link into the document head.
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
export function injectPreloadLinks(assetBase = CDN_BASE): void {
	if (typeof document === 'undefined') return;

	const link = document.createElement('link');
	link.rel = 'preload';
	link.as = 'fetch';
	link.type = 'application/wasm';
	link.crossOrigin = 'anonymous';
	link.href = `${assetBase.replace(/\/$/, '')}/dist/wa-sqlite-async.wasm`;
	document.head.appendChild(link);
}
