import { v, type Infer } from 'convex/values';
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

		// CRDT Registers - preserve concurrent changes with custom resolution
		// Priority order: done > in_progress > todo > backlog > canceled
		status: schema.register<Infer<typeof statusValidator>>(statusValidator, {
			resolve: (conflict) => {
				const priority = { done: 4, in_progress: 3, todo: 2, backlog: 1, canceled: 0 };
				return conflict.values.sort((a, b) => (priority[b] ?? 0) - (priority[a] ?? 0))[0];
			},
		}),

		// Priority order: urgent > high > medium > low > none
		priority: schema.register<Infer<typeof priorityValidator>>(priorityValidator, {
			resolve: (conflict) => {
				const priority = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };
				return conflict.values.sort((a, b) => (priority[b] ?? 0) - (priority[a] ?? 0))[0];
			},
		}),

		// CRDT Set - add-wins semantics for tags
		tags: schema.set(v.string()),

		// CRDT Counter - track page views
		viewCount: schema.counter(),

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
		tags: [],
		viewCount: 0,
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
