import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routerWithQueryClient } from "@tanstack/react-router-with-query";
import { ConvexClient } from "convex/browser";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Initialize Convex client at module level for RxDB replication (WebSocket-based)
const convexUrl = import.meta.env.VITE_CONVEX_URL;
if (!convexUrl) {
	throw new Error("VITE_CONVEX_URL environment variable is required");
}
export const convexClient = new ConvexClient(convexUrl);

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
			<div className="p-6 max-w-md mx-auto">
				<div className="bg-rose-pine-surface border border-rose-pine-rose text-rose-pine-text px-4 py-3 rounded">
					<h2 className="text-xl font-bold mb-2">404 - Page Not Found</h2>
					<p className="text-rose-pine-muted">The page you're looking for doesn't exist.</p>
				</div>
			</div>
		),
	});

	return routerWithQueryClient(router, queryClient);
};

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
