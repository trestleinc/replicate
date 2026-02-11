import { v } from 'convex/values';
import { schema } from '@trestleinc/replicate/server';

/**
 * Versioned schema for comments collection.
 *
 * When you need to add/remove/change fields:
 * 1. Increment the version number
 * 2. Update the shape with the new structure
 * 3. Add the previous version to history
 * 4. Add defaults for any new optional fields
 */
export const commentSchema = schema.define({
	shape: v.object({
		id: v.string(),
		ownerId: v.optional(v.string()),
		isPublic: v.boolean(),
		intervalId: v.string(),
		body: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),

	indexes: (t: any) =>
		t
			.index('by_interval', ['intervalId'])
			.index('by_owner', ['ownerId'])
			.index('by_public', ['isPublic']),

	defaults: {
		isPublic: false,
	},

	history: {},
});

/**
 * Document validator including system fields.
 * Used for query `returns` validation.
 */
export const commentDocValidator = commentSchema.shape.extend({
	_id: v.id('comments'),
	_creationTime: v.number(),
	timestamp: v.number(),
});
