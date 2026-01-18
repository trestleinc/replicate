import { collection, identity } from "@trestleinc/replicate/client";
import { api } from "$convex/_generated/api";
import { intervalSchema } from "$convex/schema";
import { createPersistence } from "$lib/sqlite";
import { getConvexClient } from "$lib/convex";
import { getAuthClient } from "$lib/auth-client";
import type { Infer } from "convex/values";

/**
 * Intervals collection using the new versioned schema API.
 *
 * Features:
 * - Automatic client-side migrations when schema version changes
 * - Type-safe with Convex validators
 * - Optional migration error handling
 *
 * Note: convexClient and authClient use lazy getters that throw during SSR.
 * The config function is only called when collection.init() runs (browser only).
 */
export const intervals = collection.create({
	schema: intervalSchema,
	persistence: createPersistence,
	config: () => {
		// Lazy getters - safe because config() is only called during init() in browser
		const convexClient = getConvexClient();
		const authClient = getAuthClient();

		return {
			convexClient,
			api: api.intervals,
			getKey: (interval: Interval) => interval.id,
			user: () => {
				const store = authClient.useSession();
				const session = store.get();
				if (!session.data?.user) return undefined;
				return identity.from({
					id: session.data.user.id,
					name: session.data.user.name,
					avatar: session.data.user.image ?? undefined,
					color: identity.color.generate(session.data.user.id),
				});
			},
		};
	},
	// Optional: Handle migration errors gracefully
	onMigrationError: async (error, context) => {
		console.error("Migration error:", error);
		// If no pending changes, safe to reset
		if (context.canResetSafely) {
			return { action: "reset" };
		}
		// Otherwise keep old schema and let sync resolve it
		return { action: "keep-old-schema" };
	},
});

// Type inference from the versioned schema
export type Interval = Infer<typeof intervalSchema.shape>;
