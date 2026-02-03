import { ConvexError } from 'convex/values';
import { getAuthUserId } from './authUtils';

// ============================================================================
// Predicate Functions - Single source of truth for access checks
// ============================================================================

/**
 * Check if document is publicly visible.
 */
const isPublicDoc = (doc: OwnedDocument): boolean => doc.isPublic === true;

/**
 * Check if user owns the document.
 */
const isOwner = (doc: OwnedDocument, userId: string | null): boolean =>
	userId !== null && doc.ownerId === userId;

// ============================================================================
// Types
// ============================================================================

interface OwnedDocument {
	[x: string]: unknown;
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
 * Uses predicate functions for clean, testable access control.
 */
export function createOwnershipHooks(collectionName: string) {
	return {
		evalWrite: async (ctx: any, doc: OwnedDocument) => {
			// Early return for public docs
			if (isPublicDoc(doc)) return;

			const userId = await getAuthUserId(ctx);

			// Guard clause - not owner
			if (!isOwner(doc, userId)) {
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

			// Early returns - no nested ifs
			if (!doc) return;
			if (isPublicDoc(doc)) return;

			const userId = await getAuthUserId(ctx);

			if (!isOwner(doc, userId)) {
				throw new ConvexError({
					code: 'FORBIDDEN',
					message: `Cannot delete private ${collectionName} you don't own`,
				});
			}
		},
	};
}
