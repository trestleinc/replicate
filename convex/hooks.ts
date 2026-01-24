import { ConvexError } from 'convex/values';
import { getAuthUserId } from './authUtils';

interface OwnedDocument {
	[x: string]: any;
	isPublic?: boolean;
	ownerId?: string;
}

/**
 * Shared view function that filters by ownership/public visibility.
 */
export function createVisibilityView() {
	return async (ctx: any, q: any) => {
		const userId = await getAuthUserId(ctx);

		if (!userId) {
			return q.filter((f: any) => f.eq(f.field('isPublic'), true)).order('desc');
		}

		return q
			.filter((f: any) => f.or(f.eq(f.field('isPublic'), true), f.eq(f.field('ownerId'), userId)))
			.order('desc');
	};
}

/**
 * Shared ownership hooks factory for evalWrite and evalRemove.
 */
export function createOwnershipHooks(collectionName: string) {
	return {
		evalWrite: async (ctx: any, doc: OwnedDocument) => {
			if (doc.isPublic) return;

			const userId = await getAuthUserId(ctx);
			if (!userId || doc.ownerId !== userId) {
				throw new ConvexError({
					code: 'FORBIDDEN',
					message: `Cannot edit private ${collectionName} you don't own`,
				});
			}
		},

		evalRemove: async (ctx: any, docId: string) => {
			const doc = await ctx.db
				.query(collectionName)
				.withIndex('by_doc_id', (q: any) => q.eq('id', docId))
				.first();

			if (!doc) return;
			if (doc.isPublic) return;

			const userId = await getAuthUserId(ctx);
			if (!userId || doc.ownerId !== userId) {
				throw new ConvexError({
					code: 'FORBIDDEN',
					message: `Cannot delete private ${collectionName} you don't own`,
				});
			}
		},
	};
}
