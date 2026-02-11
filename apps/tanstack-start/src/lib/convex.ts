import { ConvexClient } from 'convex/browser';

let client: ConvexClient | null = null;

export function getConvexClient(): ConvexClient {
	if (!client) {
		client = new ConvexClient(import.meta.env.PUBLIC_CONVEX_URL!);
	}
	return client;
}
