import { createSvelteKitHandler } from '@mmailaender/convex-better-auth-svelte/sveltekit';
import type { RequestHandler } from './$types';

const { GET: _GET, POST: _POST } = createSvelteKitHandler();

/**
 * Wraps the auth proxy handler with error handling and silent retry.
 *
 * The underlying handler proxies requests to the Convex site URL. On cold start,
 * the Convex HTTP action may take longer than expected, causing the fetch to be
 * aborted (SvelteKit propagates the request's AbortSignal via `new Request(url, request)`).
 *
 * This wrapper catches the AbortError and retries once before returning a 503.
 */
const wrap =
	(handler: RequestHandler): RequestHandler =>
	async (event) => {
		try {
			return await handler(event);
		} catch {
			// Silent retry on first failure (Convex cold start)
			try {
				return await handler(event);
			} catch {
				return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
					status: 503,
					headers: { 'content-type': 'application/json' },
				});
			}
		}
	};

export const GET = wrap(_GET);
export const POST = wrap(_POST);
