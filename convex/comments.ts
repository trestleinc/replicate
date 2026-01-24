import { collection } from '@trestleinc/replicate/server';
import { query } from './_generated/server';
import { components } from './_generated/api';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { createVisibilityView, createOwnershipHooks } from './hooks';
import { commentSchema, commentDocValidator } from './schema/comments';

export const { material, delta, replicate, presence, session } = collection.create<Doc<'comments'>>(
	components.replicate,
	'comments',
	{
		schema: commentSchema,
		view: createVisibilityView(),
		hooks: createOwnershipHooks('comments'),
	}
);

export const get = query({
	args: { id: v.string() },
	returns: v.union(commentDocValidator, v.null()),
	handler: async (ctx, { id }) => {
		return (await ctx.db
			.query('comments')
			.withIndex('by_doc_id', (q) => q.eq('id', id))
			.first()) as any;
	},
});

export const listByInterval = query({
	args: { intervalId: v.string() },
	returns: v.array(commentDocValidator),
	handler: async (ctx, { intervalId }) => {
		return (await ctx.db
			.query('comments')
			.withIndex('by_interval', (q) => q.eq('intervalId', intervalId))
			.collect()) as any;
	},
});
