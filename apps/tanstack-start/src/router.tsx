import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { routerWithQueryClient } from '@tanstack/react-router-with-query';
import { ConvexClient } from 'convex/browser';

// Import the generated route tree
import { routeTree } from './routeTree.gen';

// Initialize Convex client at module level for replication (WebSocket-based).
// During SSR, import.meta.env may not expose PUBLIC_CONVEX_URL, so we guard.
const convexUrl = import.meta.env.PUBLIC_CONVEX_URL;
export const convexClient = convexUrl ? new ConvexClient(convexUrl) : null;

// Export queryClient so other modules can use it
export let queryClient: QueryClient;

// Create a new router instance
export const getRouter = () => {
	// Create QueryClient for TanStack Router
	queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 5 * 60 * 1000, // 5 minutes
				retry: 1,
			},
		},
	});

	const router = createRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreloadStaleTime: 0,
		context: { queryClient },
		defaultNotFoundComponent: () => (
			<div className="mx-auto max-w-md p-6">
				<div className="bg-rose-pine-surface border-rose-pine-rose text-rose-pine-text rounded border px-4 py-3">
					<h2 className="mb-2 text-xl font-bold">404 - Page Not Found</h2>
					<p className="text-rose-pine-muted">
						The page you&apos;re looking for doesn&apos;t exist.
					</p>
				</div>
			</div>
		),
	});

	return routerWithQueryClient(router, queryClient);
};

declare module '@tanstack/react-router' {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
