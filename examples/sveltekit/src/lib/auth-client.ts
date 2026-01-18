import { browser } from "$app/environment";
import { createAuthClient } from "better-auth/svelte";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

// Type the auth client with the convex plugin included
const createConfiguredAuthClient = () =>
	createAuthClient({
		plugins: [convexClient()],
	});

type AuthClient = ReturnType<typeof createConfiguredAuthClient>;

let _authClient: AuthClient | null = null;

/**
 * Get the shared authClient instance.
 *
 * @throws Error if called during SSR (browser-only)
 */
export function getAuthClient(): AuthClient {
	if (!browser) {
		throw new Error("getAuthClient() can only be called in the browser");
	}
	if (!_authClient) {
		_authClient = createConfiguredAuthClient();
	}
	return _authClient;
}
