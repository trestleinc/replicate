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
export function preloadLinks(): string {
	return `<link rel="preload" href="${WASM_URL}" as="fetch" type="application/wasm" crossorigin>`;
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
let _compiled: Promise<WebAssembly.Module> | null = null;

export function compileWasmModule(): Promise<WebAssembly.Module> {
	if (typeof window === 'undefined') {
		return Promise.reject(new Error('compileWasmModule is browser-only'));
	}
	if (!_compiled) {
		_compiled = WebAssembly.compileStreaming(fetch(WASM_URL));
	}
	return _compiled;
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
export function injectPreloadLinks(): void {
	if (typeof document === 'undefined') return;

	const link = document.createElement('link');
	link.rel = 'preload';
	link.as = 'fetch';
	link.type = 'application/wasm';
	link.crossOrigin = 'anonymous';
	link.href = WASM_URL;
	document.head.appendChild(link);
}
