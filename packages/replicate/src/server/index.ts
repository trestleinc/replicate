/**
 * @trestleinc/replicate - Server exports
 *
 * Import from '@trestleinc/replicate/server' to use in Convex functions.
 */

import { v } from 'convex/values';
import type {
	GenericMutationCtx,
	GenericQueryCtx,
	GenericDataModel,
	GenericTableInfo,
	QueryInitializer,
	OrderedQuery,
	Query,
} from 'convex/server';
import { queryGeneric, mutationGeneric } from 'convex/server';
import { ConvexError } from 'convex/values';
import {
	type CompactionConfig,
	parseDuration,
	profileValidator,
	cursorValidator,
	sessionValidator,
	successSeqValidator,
	replicateTypeValidator,
	sessionActionValidator,
} from '$/shared';

// ============================================================================
// Guard Functions
// ============================================================================

/**
 * Validate material is provided for non-delete operations.
 * Throws ConvexError with context if material is undefined.
 */
const requireMaterial = <T>(material: T | undefined, operation: string): T => {
	if (material === undefined) {
		throw new ConvexError({ code: 'INVALID_ARGS', message: `material required for ${operation}` });
	}
	return material;
};

/**
 * Safely invoke a hook with error context wrapping.
 * Returns immediately if hook is undefined.
 */
const safeHook = async <T>(
	hookName: string,
	hook: ((ctx: any, arg: T) => void | Promise<void>) | undefined,
	ctx: any,
	arg: T
): Promise<void> => {
	if (!hook) return;
	try {
		await hook(ctx, arg);
	} catch (error) {
		throw new ConvexError({
			code: 'HOOK_FAILED',
			message: `${hookName} failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
};

// ============================================================================
// Re-exports
// ============================================================================

export { collection } from '$/server/collection';
export type { CollectionOptions } from '$/server/collection';

// Migration types
export type {
	FieldType,
	SchemaDiffOperation,
	SchemaDiff,
	MigrationContext,
	MigrationDefinition,
	MigrationMap,
	SchemaDefinitionOptions,
	VersionedSchema,
	VersionedSchemaBase,
	SchemaMigrations,
	TableOptions,
} from '$/server/migration';

import { prose, counter, register, set } from '$/server/schema';
import { define } from '$/server/migration';

export const schema = {
	prose,
	counter,
	register,
	set,
	define,
} as const;

// ============================================================================
// View Function Type
// ============================================================================

/** Query type returned by view functions - supports filter, order, collect, paginate */
type ViewQuery<TableInfo extends GenericTableInfo = GenericTableInfo> =
	| OrderedQuery<TableInfo>
	| Query<TableInfo>;

/**
 * View function for filtering/ordering collection queries.
 * Receives a QueryInitializer and returns an OrderedQuery or Query.
 *
 * @example
 * ```typescript
 * view: async (ctx, q) => {
 *   const userId = await getAuthUserId(ctx);
 *   return q.filter(f => f.eq(f.field("ownerId"), userId)).order("desc");
 * }
 * ```
 */
export type ViewFunction<TableInfo extends GenericTableInfo = GenericTableInfo> = (
	ctx: GenericQueryCtx<GenericDataModel>,
	query: QueryInitializer<TableInfo>
) => ViewQuery<TableInfo> | Promise<ViewQuery<TableInfo>>;

// ============================================================================
// Replicate Class
// ============================================================================

interface StreamChange {
	document: string;
	bytes: ArrayBuffer;
	seq: number;
	type: string;
}

async function enrichChangesWithExistence(
	ctx: GenericQueryCtx<GenericDataModel>,
	collection: string,
	changes: StreamChange[],
	view?: ViewFunction
): Promise<(StreamChange & { exists: boolean })[]> {
	const docIdSet = new Set<string>();
	for (const change of changes) {
		docIdSet.add(change.document);
	}

	const existingDocs = new Set<string>();

	for (const docId of docIdSet) {
		const doc = await ctx.db
			.query(collection)
			.withIndex('by_doc_id', (q: any) => q.eq('id', docId))
			.first();

		if (!doc) continue;

		if (view) {
			const viewQuery = await view(ctx, ctx.db.query(collection));
			const visible = await viewQuery.filter((q: any) => q.eq(q.field('id'), docId)).first();
			if (visible) existingDocs.add(docId);
		} else {
			existingDocs.add(docId);
		}
	}

	return changes.map((c) => ({
		...c,
		exists: existingDocs.has(c.document),
	}));
}

const DEFAULT_THRESHOLD = 500;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export class Replicate<T extends object> {
	private threshold: number;
	private timeout: number;
	private retain: number;

	constructor(
		public component: any,
		public collectionName: string,
		compaction?: Partial<CompactionConfig>
	) {
		this.threshold = compaction?.threshold ?? DEFAULT_THRESHOLD;
		this.timeout = compaction?.timeout ? parseDuration(compaction.timeout) : DEFAULT_TIMEOUT_MS;
		this.retain = compaction?.retain ?? 0;
	}

	createMaterialQuery(opts?: {
		view?: ViewFunction;
		transform?: (docs: T[]) => T[] | Promise<T[]>;
	}) {
		const collection = this.collectionName;

		return queryGeneric({
			args: {
				numItems: v.optional(v.number()),
				cursor: v.optional(v.string()),
			},
			returns: v.any(),
			handler: async (ctx, args) => {
				const query = opts?.view
					? await opts.view(ctx, ctx.db.query(collection))
					: ctx.db.query(collection).withIndex('by_timestamp').order('desc');

				if (args.numItems !== undefined) {
					const result = await query.paginate({
						numItems: args.numItems,
						cursor: args.cursor ?? null,
					});

					let docs = result.page as T[];
					if (opts?.transform) {
						docs = await opts.transform(docs);
					}

					return {
						page: docs,
						isDone: result.isDone,
						continueCursor: result.continueCursor,
					};
				}

				let docs = (await query.collect()) as T[];
				if (opts?.transform) {
					docs = await opts.transform(docs);
				}

				return {
					documents: docs,
					count: docs.length,
				};
			},
		});
	}

	createReplicateMutation(opts?: {
		evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
		evalRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
		onInsert?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
		onUpdate?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
		onRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;
		const { threshold, timeout, retain } = this;

		return mutationGeneric({
			args: {
				document: v.string(),
				bytes: v.bytes(),
				material: v.optional(v.any()),
				type: replicateTypeValidator,
			},
			returns: successSeqValidator,
			handler: async (ctx, args) => {
				const { document, bytes, material, type } = args;

				// Delete operation - no material required
				if (type === 'delete') {
					await safeHook('evalRemove', opts?.evalRemove, ctx, document);

					const existing = await ctx.db
						.query(collection)
						.withIndex('by_doc_id', (q) => q.eq('id', document))
						.first();

					if (existing) {
						await ctx.db.delete(existing._id);
					}

					const result = await ctx.runMutation(component.mutations.deleteDocument, {
						collection,
						document,
						bytes,
						threshold,
						timeout,
						retain,
					});

					await safeHook('onRemove', opts?.onRemove, ctx, document);
					return { success: true, seq: result.seq };
				}

				// Insert/Update - require material
				const doc = requireMaterial(material, type) as T;
				await safeHook('evalWrite', opts?.evalWrite, ctx, doc);

				// Insert operation
				if (type === 'insert') {
					await ctx.db.insert(collection, {
						id: document,
						...(doc as object),
						timestamp: Date.now(),
					});

					const result = await ctx.runMutation(component.mutations.insertDocument, {
						collection,
						document,
						bytes,
						threshold,
						timeout,
						retain,
					});

					await safeHook('onInsert', opts?.onInsert, ctx, doc);
					return { success: true, seq: result.seq };
				}

				// Update operation (fallthrough)
				const existing = await ctx.db
					.query(collection)
					.withIndex('by_doc_id', (q) => q.eq('id', document))
					.first();

				if (existing) {
					await ctx.db.patch(existing._id, {
						...(doc as object),
						timestamp: Date.now(),
					});
				}

				const result = await ctx.runMutation(component.mutations.updateDocument, {
					collection,
					document,
					bytes,
					threshold,
					timeout,
					retain,
				});

				await safeHook('onUpdate', opts?.onUpdate, ctx, doc);
				return { success: true, seq: result.seq };
			},
		});
	}

	createSessionMutation(opts?: {
		view?: ViewFunction;
		evalSession?: (
			ctx: GenericMutationCtx<GenericDataModel>,
			client: string
		) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return mutationGeneric({
			args: {
				document: v.string(),
				client: v.string(),
				action: sessionActionValidator,
				user: v.optional(v.string()),
				profile: v.optional(profileValidator),
				cursor: v.optional(cursorValidator),
				interval: v.optional(v.number()),
				vector: v.optional(v.bytes()),
				seq: v.optional(v.number()),
			},
			returns: v.null(),
			handler: async (ctx, args) => {
				if (opts?.view) {
					const viewQuery = await opts.view(ctx as any, ctx.db.query(collection));
					const canAccess = await viewQuery
						.filter((q: any) => q.eq(q.field('id'), args.document))
						.first();
					if (!canAccess) {
						// Silently return for unauthorized documents (e.g., stale cached docs after logout)
						return null;
					}
				}

				if (opts?.evalSession) {
					await opts.evalSession(ctx, args.client);
				}

				const { action, document, client, user, profile, cursor, interval, vector, seq } = args;

				if (action === 'mark') {
					await ctx.runMutation(component.mutations.mark, {
						collection,
						document,
						client,
						seq,
						vector,
					});
					return null;
				}

				if (action === 'signal') {
					if (seq !== undefined || vector !== undefined) {
						await ctx.runMutation(component.mutations.mark, {
							collection,
							document,
							client,
							seq,
							vector,
						});
					}

					await ctx.runMutation(component.mutations.presence, {
						collection,
						document,
						client,
						action: 'join',
						user,
						profile,
						cursor,
						interval,
						vector,
					});
					return null;
				}

				const presenceAction = action === 'join' || action === 'leave' ? action : 'join';
				await ctx.runMutation(component.mutations.presence, {
					collection,
					document,
					client,
					action: presenceAction,
					user,
					profile,
					cursor,
					interval,
					vector,
				});

				return null;
			},
		});
	}

	createDeltaQuery(opts?: {
		view?: ViewFunction;
		onDelta?: (ctx: GenericQueryCtx<GenericDataModel>, result: any) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return queryGeneric({
			args: {
				seq: v.optional(v.number()),
				limit: v.optional(v.number()),
				threshold: v.optional(v.number()),
				document: v.optional(v.string()),
				vector: v.optional(v.bytes()),
			},
			returns: v.any(),
			handler: async (ctx, args) => {
				if (args.vector !== undefined && args.document === undefined) {
					throw new ConvexError({
						code: 'INVALID_ARGS',
						message: "'document' is required when 'vector' is provided",
					});
				}

				if (args.vector !== undefined && args.document !== undefined) {
					const recoveryResult = await ctx.runQuery(component.mutations.recovery, {
						collection,
						document: args.document,
						vector: args.vector,
					});
					return { mode: 'recovery' as const, ...recoveryResult };
				}

				const result = await ctx.runQuery(component.mutations.stream, {
					collection,
					seq: args.seq ?? 0,
					limit: args.limit,
					threshold: args.threshold,
				});

				const enrichedChanges = await enrichChangesWithExistence(
					ctx,
					collection,
					result.changes,
					opts?.view
				);
				const enrichedResult = { mode: 'stream' as const, ...result, changes: enrichedChanges };

				if (opts?.onDelta) {
					await opts.onDelta(ctx, enrichedResult);
				}

				return enrichedResult;
			},
		});
	}

	createSessionQuery(opts?: { view?: ViewFunction }) {
		const component = this.component;
		const collection = this.collectionName;

		return queryGeneric({
			args: {
				document: v.string(),
				connected: v.optional(v.boolean()),
				exclude: v.optional(v.string()),
			},
			returns: v.array(sessionValidator),
			handler: async (ctx, args) => {
				if (opts?.view) {
					const viewQuery = await opts.view(ctx, ctx.db.query(collection));
					const canAccess = await viewQuery
						.filter((q: any) => q.eq(q.field('id'), args.document))
						.first();
					if (!canAccess) {
						// Return empty sessions for unauthorized documents
						return [];
					}
				}

				return await ctx.runQuery(component.mutations.sessions, {
					collection,
					document: args.document,
					connected: args.connected,
					exclude: args.exclude,
				});
			},
		});
	}
}
