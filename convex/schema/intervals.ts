import { v } from 'convex/values';
import { schema } from '@trestleinc/replicate/server';

const statusValidator = v.union(
	v.literal('backlog'),
	v.literal('todo'),
	v.literal('in_progress'),
	v.literal('done'),
	v.literal('canceled')
);

const priorityValidator = v.union(
	v.literal('none'),
	v.literal('low'),
	v.literal('medium'),
	v.literal('high'),
	v.literal('urgent')
);

/**
 * Versioned schema for intervals collection.
 *
 * When you need to add/remove/change fields:
 * 1. Increment the version number
 * 2. Update the shape with the new structure
 * 3. Add the previous version to history
 * 4. Add defaults for any new optional fields
 */
export const intervalSchema = schema.define({
	shape: v.object({
		id: v.string(),
		ownerId: v.optional(v.string()),
		isPublic: v.boolean(),
		title: v.string(),
		description: schema.prose(),
		status: statusValidator,
		priority: priorityValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	}),

	indexes: (t: any) =>
		t
			.index('by_status', ['status'])
			.index('by_priority', ['priority'])
			.index('by_updated', ['updatedAt'])
			.index('by_owner', ['ownerId'])
			.index('by_public', ['isPublic']),

	defaults: {
		isPublic: false,
		status: 'backlog',
		priority: 'none',
	},

	history: {},
});

/**
 * Document validator including system fields.
 * Used for query `returns` validation.
 */
export const intervalDocValidator = intervalSchema.shape.extend({
	_id: v.id('intervals'),
	_creationTime: v.number(),
	timestamp: v.number(),
});

// Re-export validators for use in Convex schema
export { statusValidator, priorityValidator };
