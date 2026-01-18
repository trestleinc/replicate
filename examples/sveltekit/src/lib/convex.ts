import { browser } from "$app/environment";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";

let _convexClient: ConvexClient | null = null;

/**
 * Get the shared ConvexClient instance.
 * Auth is configured by createSvelteAuthClient in +layout.svelte.
 *
 * @throws Error if called during SSR (browser-only)
 */
export function getConvexClient(): ConvexClient {
	if (!browser) {
		throw new Error("getConvexClient() can only be called in the browser");
	}
	if (!_convexClient) {
		_convexClient = new ConvexClient(PUBLIC_CONVEX_URL);
	}
	return _convexClient;
}
