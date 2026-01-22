import { collection } from '@trestleinc/replicate/client';
import { api } from '$convex/_generated/api';
import { commentSchema } from '$convex/schema/comments';
import { createPersistence } from '$lib/sqlite';
import { getConvexClient } from '$lib/convex';
import { resolveUserIdentity, handleMigrationError } from './shared';
import type { Infer } from 'convex/values';

/**
 * Comments collection using the new versioned schema API.
 */
export const comments = collection.create({
	schema: commentSchema,
	persistence: createPersistence,
	config: () => ({
		convexClient: getConvexClient(),
		api: api.comments,
		getKey: (comment: Comment) => comment.id,
		user: resolveUserIdentity,
	}),
	onMigrationError: handleMigrationError,
});

// Type inference from the versioned schema
export type Comment = Infer<typeof commentSchema.shape>;
