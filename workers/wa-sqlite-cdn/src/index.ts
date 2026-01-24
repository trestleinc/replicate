interface Env {
	WA_SQLITE_BUCKET: R2Bucket;
}

const CONTENT_TYPES: Record<string, string> = {
	'.wasm': 'application/wasm',
	'.mjs': 'application/javascript',
	'.js': 'application/javascript',
};

function getContentType(path: string): string {
	for (const [ext, type] of Object.entries(CONTENT_TYPES)) {
		if (path.endsWith(ext)) return type;
	}
	return 'application/octet-stream';
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
					'Access-Control-Allow-Headers': '*',
					'Access-Control-Max-Age': '86400',
				},
			});
		}

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		const url = new URL(request.url);
		const key = url.pathname.slice(1); // Remove leading slash

		if (!key) {
			return new Response('Not Found', { status: 404 });
		}

		const object = await env.WA_SQLITE_BUCKET.get(key);

		if (!object) {
			return new Response('Not Found', { status: 404 });
		}

		const headers = new Headers();
		headers.set('Content-Type', getContentType(key));

		// Immutable cache for versioned paths — cached at edge + browser for 1 year
		headers.set('Cache-Control', 'public, max-age=31536000, immutable');

		// CORS
		headers.set('Access-Control-Allow-Origin', '*');
		headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

		// ETag for conditional requests
		headers.set('ETag', object.httpEtag);

		if (request.method === 'HEAD') {
			return new Response(null, { headers });
		}

		return new Response(object.body, { headers });
	},
} satisfies ExportedHandler<Env>;
