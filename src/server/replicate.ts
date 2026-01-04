import { v } from "convex/values";
import type { GenericMutationCtx, GenericQueryCtx, GenericDataModel } from "convex/server";
import { queryGeneric, mutationGeneric } from "convex/server";
import { type CompactionConfig, parseSize, parseDuration } from "$/shared/types";
import {
	profileValidator,
	cursorValidator,
	streamResultWithExistsValidator,
	sessionValidator,
	presenceActionValidator,
	successSeqValidator,
	compactResultValidator,
	replicateTypeValidator,
	sessionActionValidator,
} from "$/shared/validators";

const BYTES_PER_MB = 1024 * 1024;
const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_SIZE_THRESHOLD_5MB = 5 * BYTES_PER_MB;
const DEFAULT_PEER_TIMEOUT_24H = 24 * MS_PER_HOUR;

export class Replicate<T extends object> {
	private sizeThreshold: number;
	private peerTimeout: number;

	constructor(
		public component: any,
		public collectionName: string,
		compaction?: Partial<CompactionConfig>,
	) {
		this.sizeThreshold = compaction?.sizeThreshold
			? parseSize(compaction.sizeThreshold)
			: DEFAULT_SIZE_THRESHOLD_5MB;
		this.peerTimeout = compaction?.peerTimeout
			? parseDuration(compaction.peerTimeout)
			: DEFAULT_PEER_TIMEOUT_24H;
	}

	createStreamQuery(opts?: {
		evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
		onStream?: (ctx: GenericQueryCtx<GenericDataModel>, result: any) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return queryGeneric({
			args: {
				seq: v.number(),
				limit: v.optional(v.number()),
				threshold: v.optional(v.number()),
			},
			returns: streamResultWithExistsValidator,
			handler: async (ctx, args) => {
				if (opts?.evalRead) {
					await opts.evalRead(ctx, collection);
				}
				const result = await ctx.runQuery(component.mutations.stream, {
					collection,
					seq: args.seq,
					limit: args.limit,
					threshold: args.threshold,
				});

				const docIdSet = new Set<string>();
				for (const change of result.changes) {
					docIdSet.add((change as { document: string }).document);
				}

				const existingDocs = new Set<string>();
				for (const docId of docIdSet) {
					const doc = await ctx.db
						.query(collection)
						.withIndex("by_doc_id", (q: any) => q.eq("id", docId))
						.first();
					if (doc) existingDocs.add(docId);
				}

				interface StreamChange {
					document: string;
					bytes: ArrayBuffer;
					seq: number;
					type: string;
				}
				const enrichedChanges = result.changes.map((c: StreamChange) => ({
					...c,
					exists: existingDocs.has(c.document),
				}));

				const enrichedResult = { ...result, changes: enrichedChanges };

				if (opts?.onStream) {
					await opts.onStream(ctx, enrichedResult);
				}

				return enrichedResult;
			},
		});
	}

	createMaterialQuery(opts?: {
		evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
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
				if (opts?.evalRead) {
					await opts.evalRead(ctx, collection);
				}

				if (args.numItems !== undefined) {
					const result = await ctx.db
						.query(collection)
						.withIndex("by_timestamp")
						.order("desc")
						.paginate({ numItems: args.numItems, cursor: args.cursor ?? null });

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

				let docs = (await ctx.db.query(collection).collect()) as T[];
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

	createInsertMutation(opts?: {
		evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
		onInsert?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return mutationGeneric({
			args: {
				document: v.string(),
				bytes: v.bytes(),
				material: v.any(),
			},
			returns: successSeqValidator,
			handler: async (ctx, args) => {
				const doc = args.material as T;

				if (opts?.evalWrite) {
					await opts.evalWrite(ctx, doc);
				}

				await ctx.db.insert(collection, {
					id: args.document,
					...(args.material as object),
					timestamp: Date.now(),
				});

				const result = await ctx.runMutation(component.mutations.insertDocument, {
					collection,
					document: args.document,
					bytes: args.bytes,
				});

				if (opts?.onInsert) {
					await opts.onInsert(ctx, doc);
				}

				return {
					success: true,
					seq: result.seq,
				};
			},
		});
	}

	createUpdateMutation(opts?: {
		evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
		onUpdate?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return mutationGeneric({
			args: {
				document: v.string(),
				bytes: v.bytes(),
				material: v.any(),
			},
			returns: successSeqValidator,
			handler: async (ctx, args) => {
				const doc = args.material as T;

				if (opts?.evalWrite) {
					await opts.evalWrite(ctx, doc);
				}

				const existing = await ctx.db
					.query(collection)
					.withIndex("by_doc_id", q => q.eq("id", args.document))
					.first();

				if (existing) {
					await ctx.db.patch(existing._id, {
						...(args.material as object),
						timestamp: Date.now(),
					});
				}

				const result = await ctx.runMutation(component.mutations.updateDocument, {
					collection,
					document: args.document,
					bytes: args.bytes,
				});

				if (opts?.onUpdate) {
					await opts.onUpdate(ctx, doc);
				}

				return {
					success: true,
					seq: result.seq,
				};
			},
		});
	}

	createRemoveMutation(opts?: {
		evalRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
		onRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return mutationGeneric({
			args: {
				document: v.string(),
				bytes: v.bytes(),
			},
			returns: successSeqValidator,
			handler: async (ctx, args) => {
				if (opts?.evalRemove) {
					await opts.evalRemove(ctx, args.document);
				}

				const existing = await ctx.db
					.query(collection)
					.withIndex("by_doc_id", q => q.eq("id", args.document))
					.first();

				if (existing) {
					await ctx.db.delete(existing._id);
				}

				const result = await ctx.runMutation(component.mutations.deleteDocument, {
					collection,
					document: args.document,
					bytes: args.bytes,
				});

				if (opts?.onRemove) {
					await opts.onRemove(ctx, args.document);
				}

				return {
					success: true,
					seq: result.seq,
				};
			},
		});
	}

	createMarkMutation(opts?: {
		evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, client: string) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return mutationGeneric({
			args: {
				document: v.string(),
				client: v.string(),
				seq: v.optional(v.number()),
				vector: v.optional(v.bytes()),
			},
			returns: v.null(),
			handler: async (ctx, args) => {
				if (opts?.evalWrite) {
					await opts.evalWrite(ctx, args.client);
				}

				await ctx.runMutation(component.mutations.mark, {
					collection,
					document: args.document,
					client: args.client,
					seq: args.seq,
					vector: args.vector,
				});

				return null;
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

				if (type === "delete") {
					if (opts?.evalRemove) {
						await opts.evalRemove(ctx, document);
					}

					const existing = await ctx.db
						.query(collection)
						.withIndex("by_doc_id", q => q.eq("id", document))
						.first();

					if (existing) {
						await ctx.db.delete(existing._id);
					}

					const result = await ctx.runMutation(component.mutations.deleteDocument, {
						collection,
						document,
						bytes,
					});

					if (opts?.onRemove) {
						await opts.onRemove(ctx, document);
					}

					return { success: true, seq: result.seq };
				}

				const doc = material as T;
				if (opts?.evalWrite) {
					await opts.evalWrite(ctx, doc);
				}

				if (type === "insert") {
					await ctx.db.insert(collection, {
						id: document,
						...(material as object),
						timestamp: Date.now(),
					});

					const result = await ctx.runMutation(component.mutations.insertDocument, {
						collection,
						document,
						bytes,
					});

					if (opts?.onInsert) {
						await opts.onInsert(ctx, doc);
					}

					return { success: true, seq: result.seq };
				}

				const existing = await ctx.db
					.query(collection)
					.withIndex("by_doc_id", q => q.eq("id", document))
					.first();

				if (existing) {
					await ctx.db.patch(existing._id, {
						...(material as object),
						timestamp: Date.now(),
					});
				}

				const result = await ctx.runMutation(component.mutations.updateDocument, {
					collection,
					document,
					bytes,
				});

				if (opts?.onUpdate) {
					await opts.onUpdate(ctx, doc);
				}

				return { success: true, seq: result.seq };
			},
		});
	}

	createSessionMutation(opts?: {
		evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, client: string) => void | Promise<void>;
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
				if (opts?.evalWrite) {
					await opts.evalWrite(ctx, args.client);
				}

				const { action, document, client, user, profile, cursor, interval, vector, seq } = args;

				if (action === "mark") {
					await ctx.runMutation(component.mutations.mark, {
						collection,
						document,
						client,
						seq,
						vector,
					});
					return null;
				}

				if (action === "signal") {
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
						action: "join",
						user,
						profile,
						cursor,
						interval,
						vector,
					});
					return null;
				}

				const presenceAction = action === "join" || action === "leave" ? action : "join";
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

	createSessionQuery(opts?: {
		evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
	}) {
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
				if (opts?.evalRead) {
					await opts.evalRead(ctx, collection);
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

	createDeltaQuery(opts?: {
		evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
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
				if (opts?.evalRead) {
					await opts.evalRead(ctx, collection);
				}

				if (args.vector !== undefined && args.document === undefined) {
					throw new Error("'document' is required when 'vector' is provided");
				}

				if (args.vector !== undefined && args.document !== undefined) {
					const recoveryResult = await ctx.runQuery(component.mutations.recovery, {
						collection,
						document: args.document,
						vector: args.vector,
					});
					return { mode: "recovery" as const, ...recoveryResult };
				}

				const result = await ctx.runQuery(component.mutations.stream, {
					collection,
					seq: args.seq ?? 0,
					limit: args.limit,
					threshold: args.threshold,
				});

				const docIdSet = new Set<string>();
				for (const change of result.changes) {
					docIdSet.add((change as { document: string }).document);
				}

				const existingDocs = new Set<string>();
				for (const docId of docIdSet) {
					const doc = await ctx.db
						.query(collection)
						.withIndex("by_doc_id", (q: any) => q.eq("id", docId))
						.first();
					if (doc) existingDocs.add(docId);
				}

				interface StreamChange {
					document: string;
					bytes: ArrayBuffer;
					seq: number;
					type: string;
				}
				const enrichedChanges = result.changes.map((c: StreamChange) => ({
					...c,
					exists: existingDocs.has(c.document),
				}));

				const enrichedResult = { mode: "stream" as const, ...result, changes: enrichedChanges };

				if (opts?.onDelta) {
					await opts.onDelta(ctx, enrichedResult);
				}

				return enrichedResult;
			},
		});
	}

	createSessionsQuery(opts?: {
		evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return queryGeneric({
			args: {
				document: v.string(),
				connected: v.optional(v.boolean()),
				exclude: v.optional(v.string()),
				group: v.optional(v.boolean()),
			},
			returns: v.array(sessionValidator),
			handler: async (ctx, args) => {
				if (opts?.evalRead) {
					await opts.evalRead(ctx, collection);
				}

				return await ctx.runQuery(component.mutations.sessions, {
					collection,
					document: args.document,
					connected: args.connected,
					exclude: args.exclude,
					group: args.group,
				});
			},
		});
	}

	createPresenceMutation(opts?: {
		evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, client: string) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return mutationGeneric({
			args: {
				document: v.string(),
				client: v.string(),
				action: presenceActionValidator,
				user: v.optional(v.string()),
				profile: v.optional(profileValidator),
				cursor: v.optional(cursorValidator),
				interval: v.optional(v.number()),
				vector: v.optional(v.bytes()),
			},
			returns: v.null(),
			handler: async (ctx, args) => {
				if (opts?.evalWrite) {
					await opts.evalWrite(ctx, args.client);
				}

				await ctx.runMutation(component.mutations.presence, {
					collection,
					document: args.document,
					client: args.client,
					action: args.action,
					user: args.user,
					profile: args.profile,
					cursor: args.cursor,
					interval: args.interval,
					vector: args.vector,
				});

				return null;
			},
		});
	}

	createCompactMutation(opts?: {
		evalWrite?: (
			ctx: GenericMutationCtx<GenericDataModel>,
			document: string,
		) => void | Promise<void>;
	}) {
		const component = this.component;
		const collection = this.collectionName;

		return mutationGeneric({
			args: {
				document: v.string(),
			},
			returns: compactResultValidator,
			handler: async (ctx, args) => {
				if (opts?.evalWrite) {
					await opts.evalWrite(ctx, args.document);
				}

				return await ctx.runMutation(component.mutations.compact, {
					collection,
					document: args.document,
				});
			},
		});
	}
}
