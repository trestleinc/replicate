import { collection } from '@trestleinc/replicate/client';
import { api } from '$convex/_generated/api';
import { commentSchema } from '$convex/schema/comments';
import { sqlite } from '../lib/sqlite';
import { getConvexClient } from '../lib/convex';
import type { Infer } from 'convex/values';

export const comments = collection.create({
	schema: commentSchema,
	persistence: sqlite,
	config: () => ({
		convexClient: getConvexClient(),
		api: api.comments,
		getKey: (comment: Comment) => comment.id,
	}),
});

export type Comment = Infer<typeof commentSchema.shape>;
