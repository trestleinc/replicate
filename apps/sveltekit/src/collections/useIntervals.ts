import { collection } from '@trestleinc/replicate/client';
import { api } from '$convex/_generated/api';
import { intervalSchema } from '$convex/schema/intervals';
import { createPersistence } from '$lib/sqlite';
import { getConvexClient } from '$lib/convex';
import { resolveUserIdentity, handleMigrationError } from './shared';
import type { Infer } from 'convex/values';

/**
 * Intervals collection using the new versioned schema API.
 */
export const intervals = collection.create({
	schema: intervalSchema,
	persistence: createPersistence,
	config: () => ({
		convexClient: getConvexClient(),
		api: api.intervals,
		getKey: (interval: Interval) => interval.id,
		user: resolveUserIdentity,
	}),
	onMigrationError: handleMigrationError,
});

// Type inference from the versioned schema
export type Interval = Infer<typeof intervalSchema.shape>;
