import { v } from "convex/values";
import { defineTable, mutationGeneric, queryGeneric } from "convex/server";

//#region src/shared/types.ts
const SIZE_MULTIPLIERS = {
	kb: 1024,
	mb: 1024 ** 2,
	gb: 1024 ** 3
};
const DURATION_MULTIPLIERS = {
	m: 6e4,
	h: 36e5,
	d: 864e5
};
function parseSize(s) {
	const match = /^(\d+)(kb|mb|gb)$/i.exec(s);
	if (!match) throw new Error(`Invalid size: ${s}`);
	const [, num, unit] = match;
	return parseInt(num) * SIZE_MULTIPLIERS[unit.toLowerCase()];
}
function parseDuration(s) {
	const match = /^(\d+)(m|h|d)$/i.exec(s);
	if (!match) throw new Error(`Invalid duration: ${s}`);
	const [, num, unit] = match;
	return parseInt(num) * DURATION_MULTIPLIERS[unit.toLowerCase()];
}

//#endregion
//#region src/server/replicate.ts
const BYTES_PER_MB = 1024 * 1024;
const MS_PER_HOUR = 3600 * 1e3;
const DEFAULT_SIZE_THRESHOLD_5MB = 5 * BYTES_PER_MB;
const DEFAULT_PEER_TIMEOUT_24H = 24 * MS_PER_HOUR;
var Replicate = class {
	sizeThreshold;
	peerTimeout;
	constructor(component, collectionName, compaction) {
		this.component = component;
		this.collectionName = collectionName;
		this.sizeThreshold = compaction?.sizeThreshold ? parseSize(compaction.sizeThreshold) : DEFAULT_SIZE_THRESHOLD_5MB;
		this.peerTimeout = compaction?.peerTimeout ? parseDuration(compaction.peerTimeout) : DEFAULT_PEER_TIMEOUT_24H;
	}
	createStreamQuery(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return queryGeneric({
			args: {
				seq: v.number(),
				limit: v.optional(v.number()),
				threshold: v.optional(v.number())
			},
			returns: v.object({
				changes: v.array(v.object({
					document: v.string(),
					bytes: v.bytes(),
					seq: v.number(),
					type: v.string(),
					exists: v.boolean()
				})),
				seq: v.number(),
				more: v.boolean(),
				compact: v.optional(v.object({ documents: v.array(v.string()) }))
			}),
			handler: async (ctx, args) => {
				if (opts?.evalRead) await opts.evalRead(ctx, collection$1);
				const result = await ctx.runQuery(component.mutations.stream, {
					collection: collection$1,
					seq: args.seq,
					limit: args.limit,
					threshold: args.threshold
				});
				const docIdSet = /* @__PURE__ */ new Set();
				for (const change of result.changes) docIdSet.add(change.document);
				const existingDocs = /* @__PURE__ */ new Set();
				for (const docId of docIdSet) if (await ctx.db.query(collection$1).withIndex("by_doc_id", (q) => q.eq("id", docId)).first()) existingDocs.add(docId);
				const enrichedChanges = result.changes.map((c) => ({
					...c,
					exists: existingDocs.has(c.document)
				}));
				const enrichedResult = {
					...result,
					changes: enrichedChanges
				};
				if (opts?.onStream) await opts.onStream(ctx, enrichedResult);
				return enrichedResult;
			}
		});
	}
	createSSRQuery(opts) {
		const collection$1 = this.collectionName;
		const component = this.component;
		return queryGeneric({
			args: {},
			returns: v.object({
				documents: v.any(),
				count: v.number(),
				crdt: v.optional(v.record(v.string(), v.object({
					bytes: v.bytes(),
					seq: v.number()
				}))),
				cursor: v.optional(v.number())
			}),
			handler: async (ctx) => {
				if (opts?.evalRead) await opts.evalRead(ctx, collection$1);
				let docs = await ctx.db.query(collection$1).collect();
				if (opts?.transform) docs = await opts.transform(docs);
				const response = {
					documents: docs,
					count: docs.length
				};
				if (opts?.includeCRDTState && docs.length > 0) {
					const crdt = {};
					let maxSeq = 0;
					for (const doc of docs) {
						const docId = doc.id;
						const state = await ctx.runQuery(component.mutations.getDocumentState, {
							collection: collection$1,
							document: docId
						});
						if (state) {
							crdt[docId] = {
								bytes: state.bytes,
								seq: state.seq
							};
							maxSeq = Math.max(maxSeq, state.seq);
						}
					}
					response.crdt = crdt;
					response.cursor = maxSeq;
				}
				return response;
			}
		});
	}
	createInsertMutation(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return mutationGeneric({
			args: {
				document: v.string(),
				bytes: v.bytes(),
				material: v.any()
			},
			returns: v.object({
				success: v.boolean(),
				seq: v.number()
			}),
			handler: async (ctx, args) => {
				const doc = args.material;
				if (opts?.evalWrite) await opts.evalWrite(ctx, doc);
				const result = await ctx.runMutation(component.mutations.insertDocument, {
					collection: collection$1,
					document: args.document,
					bytes: args.bytes
				});
				await ctx.db.insert(collection$1, {
					id: args.document,
					...args.material,
					timestamp: Date.now()
				});
				if (opts?.onInsert) await opts.onInsert(ctx, doc);
				return {
					success: true,
					seq: result.seq
				};
			}
		});
	}
	createUpdateMutation(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return mutationGeneric({
			args: {
				document: v.string(),
				bytes: v.bytes(),
				material: v.any()
			},
			returns: v.object({
				success: v.boolean(),
				seq: v.number()
			}),
			handler: async (ctx, args) => {
				const doc = args.material;
				if (opts?.evalWrite) await opts.evalWrite(ctx, doc);
				const result = await ctx.runMutation(component.mutations.updateDocument, {
					collection: collection$1,
					document: args.document,
					bytes: args.bytes
				});
				const existing = await ctx.db.query(collection$1).withIndex("by_doc_id", (q) => q.eq("id", args.document)).first();
				if (existing) await ctx.db.patch(existing._id, {
					...args.material,
					timestamp: Date.now()
				});
				if (opts?.onUpdate) await opts.onUpdate(ctx, doc);
				return {
					success: true,
					seq: result.seq
				};
			}
		});
	}
	createRemoveMutation(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return mutationGeneric({
			args: {
				document: v.string(),
				bytes: v.bytes()
			},
			returns: v.object({
				success: v.boolean(),
				seq: v.number()
			}),
			handler: async (ctx, args) => {
				if (opts?.evalRemove) await opts.evalRemove(ctx, args.document);
				const result = await ctx.runMutation(component.mutations.deleteDocument, {
					collection: collection$1,
					document: args.document,
					bytes: args.bytes
				});
				const existing = await ctx.db.query(collection$1).withIndex("by_doc_id", (q) => q.eq("id", args.document)).first();
				if (existing) await ctx.db.delete(existing._id);
				if (opts?.onRemove) await opts.onRemove(ctx, args.document);
				return {
					success: true,
					seq: result.seq
				};
			}
		});
	}
	createMarkMutation(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return mutationGeneric({
			args: {
				document: v.string(),
				client: v.string(),
				seq: v.optional(v.number()),
				vector: v.optional(v.bytes())
			},
			returns: v.null(),
			handler: async (ctx, args) => {
				if (opts?.evalWrite) await opts.evalWrite(ctx, args.client);
				await ctx.runMutation(component.mutations.mark, {
					collection: collection$1,
					document: args.document,
					client: args.client,
					seq: args.seq,
					vector: args.vector
				});
				return null;
			}
		});
	}
	createSessionsQuery(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return queryGeneric({
			args: {
				document: v.string(),
				connected: v.optional(v.boolean()),
				exclude: v.optional(v.string()),
				group: v.optional(v.boolean())
			},
			returns: v.array(v.object({
				client: v.string(),
				document: v.string(),
				user: v.optional(v.string()),
				profile: v.optional(v.any()),
				cursor: v.optional(v.object({
					anchor: v.any(),
					head: v.any(),
					field: v.optional(v.string())
				})),
				seen: v.number()
			})),
			handler: async (ctx, args) => {
				if (opts?.evalRead) await opts.evalRead(ctx, collection$1);
				return await ctx.runQuery(component.mutations.sessions, {
					collection: collection$1,
					document: args.document,
					connected: args.connected,
					exclude: args.exclude,
					group: args.group
				});
			}
		});
	}
	createPresenceMutation(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return mutationGeneric({
			args: {
				document: v.string(),
				client: v.string(),
				action: v.union(v.literal("join"), v.literal("leave")),
				user: v.optional(v.string()),
				profile: v.optional(v.object({
					name: v.optional(v.string()),
					color: v.optional(v.string()),
					avatar: v.optional(v.string())
				})),
				cursor: v.optional(v.object({
					anchor: v.any(),
					head: v.any(),
					field: v.optional(v.string())
				})),
				interval: v.optional(v.number()),
				vector: v.optional(v.bytes())
			},
			returns: v.null(),
			handler: async (ctx, args) => {
				if (opts?.evalWrite) await opts.evalWrite(ctx, args.client);
				await ctx.runMutation(component.mutations.presence, {
					collection: collection$1,
					document: args.document,
					client: args.client,
					action: args.action,
					user: args.user,
					profile: args.profile,
					cursor: args.cursor,
					interval: args.interval,
					vector: args.vector
				});
				return null;
			}
		});
	}
	createCompactMutation(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return mutationGeneric({
			args: { document: v.string() },
			returns: v.object({
				success: v.boolean(),
				removed: v.number(),
				retained: v.number(),
				size: v.number()
			}),
			handler: async (ctx, args) => {
				if (opts?.evalWrite) await opts.evalWrite(ctx, args.document);
				return await ctx.runMutation(component.mutations.compact, {
					collection: collection$1,
					document: args.document
				});
			}
		});
	}
	createRecoveryQuery(opts) {
		const component = this.component;
		const collection$1 = this.collectionName;
		return queryGeneric({
			args: {
				document: v.string(),
				vector: v.bytes()
			},
			returns: v.object({
				diff: v.optional(v.bytes()),
				vector: v.bytes()
			}),
			handler: async (ctx, args) => {
				if (opts?.evalRead) await opts.evalRead(ctx, collection$1, args.document);
				return await ctx.runQuery(component.mutations.recovery, {
					collection: collection$1,
					document: args.document,
					vector: args.vector
				});
			}
		});
	}
};

//#endregion
//#region src/server/collection.ts
function createCollection(component, name, options) {
	return createCollectionInternal(component, name, options);
}
const collection = { create: createCollection };
function createCollectionInternal(component, name, options) {
	const storage = new Replicate(component, name, options?.compaction);
	const hooks = options?.hooks;
	return {
		__collection: name,
		stream: storage.createStreamQuery({
			evalRead: hooks?.evalRead,
			onStream: hooks?.onStream
		}),
		material: storage.createSSRQuery({
			evalRead: hooks?.evalRead,
			transform: hooks?.transform
		}),
		recovery: storage.createRecoveryQuery({ evalRead: hooks?.evalRead }),
		insert: storage.createInsertMutation({
			evalWrite: hooks?.evalWrite,
			onInsert: hooks?.onInsert
		}),
		update: storage.createUpdateMutation({
			evalWrite: hooks?.evalWrite,
			onUpdate: hooks?.onUpdate
		}),
		remove: storage.createRemoveMutation({
			evalRemove: hooks?.evalRemove,
			onRemove: hooks?.onRemove
		}),
		mark: storage.createMarkMutation({ evalWrite: hooks?.evalMark }),
		compact: storage.createCompactMutation({ evalWrite: hooks?.evalCompact }),
		sessions: storage.createSessionsQuery({ evalRead: hooks?.evalRead }),
		presence: storage.createPresenceMutation({ evalWrite: hooks?.evalMark })
	};
}

//#endregion
//#region src/server/schema.ts
const prose = () => v.object({
	type: v.literal("doc"),
	content: v.optional(v.array(v.any()))
});
/**
* Define a table with automatic timestamp field for replication.
* All replicated tables must have an `id` field and define a `by_doc_id` index.
*
* @example
* ```typescript
* // convex/schema.ts
* export default defineSchema({
*   tasks: table(
*     { id: v.string(), text: v.string(), isCompleted: v.boolean() },
*     (t) => t.index('by_doc_id', ['id']).index('by_completed', ['isCompleted'])
*   ),
* });
* ```
*/
function table(userFields, applyIndexes) {
	const tbl = defineTable({
		...userFields,
		timestamp: v.number()
	});
	if (applyIndexes) return applyIndexes(tbl);
	return tbl;
}

//#endregion
//#region src/server/index.ts
const schema = {
	table,
	prose
};

//#endregion
export { collection, schema };