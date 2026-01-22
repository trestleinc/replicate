import { collection } from '@trestleinc/replicate/server';
import { query } from './_generated/server';
import { components } from './_generated/api';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { createVisibilityView, createOwnershipHooks } from './hooks';
import { intervalDocValidator } from './schema/intervals';

export const { material, delta, replicate, presence, session } = collection.create<
	Doc<'intervals'>
>(components.replicate, 'intervals', {
	view: createVisibilityView(),
	hooks: createOwnershipHooks('intervals'),
});

export const get = query({
	args: { id: v.string() },
	returns: v.union(intervalDocValidator, v.null()),
	handler: async (ctx, { id }) => {
		return (await ctx.db
			.query('intervals')
			.withIndex('by_doc_id', (q) => q.eq('id', id))
			.first()) as any;
	},
});

export const list = query({
	args: {},
	returns: v.array(intervalDocValidator),
	handler: async (ctx) => {
		return (await ctx.db.query('intervals').withIndex('by_updated').order('desc').collect()) as any;
	},
});

export const listByStatus = query({
	args: { status: v.string() },
	returns: v.array(intervalDocValidator),
	handler: async (ctx, { status }) => {
		return (await ctx.db
			.query('intervals')
			.withIndex('by_status', (q) => q.eq('status', status))
			.collect()) as any;
	},
});
