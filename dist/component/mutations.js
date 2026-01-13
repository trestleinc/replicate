import { getLogger } from "./logger.js";
import { mutation, query } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import { OperationType } from "./shared/types.js";
import * as Y from "yjs";
import { v } from "convex/values";

//#region src/component/mutations.ts
const DEFAULT_DELTA_COUNT_THRESHOLD = 500;
async function getNextSeq(ctx, collection) {
	return ((await ctx.db.query("documents").withIndex("by_seq", (q) => q.eq("collection", collection)).order("desc").first())?.seq ?? 0) + 1;
}
const insertDocument = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		bytes: v.bytes()
	},
	returns: v.object({
		success: v.boolean(),
		seq: v.number()
	}),
	handler: async (ctx, args) => {
		const seq = await getNextSeq(ctx, args.collection);
		await ctx.db.insert("documents", {
			collection: args.collection,
			document: args.document,
			bytes: args.bytes,
			seq
		});
		return {
			success: true,
			seq
		};
	}
});
const updateDocument = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		bytes: v.bytes()
	},
	returns: v.object({
		success: v.boolean(),
		seq: v.number()
	}),
	handler: async (ctx, args) => {
		const seq = await getNextSeq(ctx, args.collection);
		await ctx.db.insert("documents", {
			collection: args.collection,
			document: args.document,
			bytes: args.bytes,
			seq
		});
		return {
			success: true,
			seq
		};
	}
});
const deleteDocument = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		bytes: v.bytes()
	},
	returns: v.object({
		success: v.boolean(),
		seq: v.number()
	}),
	handler: async (ctx, args) => {
		const seq = await getNextSeq(ctx, args.collection);
		await ctx.db.insert("documents", {
			collection: args.collection,
			document: args.document,
			bytes: args.bytes,
			seq
		});
		return {
			success: true,
			seq
		};
	}
});
const DEFAULT_HEARTBEAT_INTERVAL = 1e4;
const mark = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		client: v.string(),
		vector: v.optional(v.bytes()),
		seq: v.optional(v.number())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db.query("sessions").withIndex("by_client", (q) => q.eq("collection", args.collection).eq("document", args.document).eq("client", args.client)).first();
		const updates = { seen: now };
		if (args.vector !== void 0) updates.vector = args.vector;
		if (args.seq !== void 0) updates.seq = existing ? Math.max(existing.seq, args.seq) : args.seq;
		if (existing) await ctx.db.patch(existing._id, updates);
		else await ctx.db.insert("sessions", {
			collection: args.collection,
			document: args.document,
			client: args.client,
			vector: args.vector,
			connected: false,
			seq: args.seq ?? 0,
			seen: now
		});
		return null;
	}
});
const compact = mutation({
	args: {
		collection: v.string(),
		document: v.string()
	},
	returns: v.object({
		success: v.boolean(),
		removed: v.number(),
		retained: v.number(),
		size: v.number()
	}),
	handler: async (ctx, args) => {
		const logger = getLogger(["compaction"]);
		const now = Date.now();
		const deltas = await ctx.db.query("documents").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).collect();
		if (deltas.length === 0) return {
			success: true,
			removed: 0,
			retained: 0,
			size: 0
		};
		const existing = await ctx.db.query("snapshots").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).first();
		const updates = [];
		if (existing) updates.push(new Uint8Array(existing.bytes));
		updates.push(...deltas.map((d) => new Uint8Array(d.bytes)));
		const merged = Y.mergeUpdatesV2(updates);
		const vector = Y.encodeStateVectorFromUpdateV2(merged);
		const sessions$1 = await ctx.db.query("sessions").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).filter((q) => q.eq(q.field("connected"), true)).collect();
		let canDeleteAll = true;
		for (const session of sessions$1) {
			if (!session.vector) {
				canDeleteAll = false;
				logger.warn("Session without vector, skipping full compaction", { client: session.client });
				break;
			}
			const sessionVector = new Uint8Array(session.vector);
			const missing = Y.diffUpdateV2(merged, sessionVector);
			if (missing.byteLength > 2) {
				canDeleteAll = false;
				logger.debug("Session still needs data", {
					client: session.client,
					missingSize: missing.byteLength
				});
				break;
			}
		}
		const seq = Math.max(...deltas.map((d) => d.seq));
		if (existing) await ctx.db.patch(existing._id, {
			bytes: merged.buffer,
			vector: vector.buffer,
			seq,
			created: now
		});
		else await ctx.db.insert("snapshots", {
			collection: args.collection,
			document: args.document,
			bytes: merged.buffer,
			vector: vector.buffer,
			seq,
			created: now
		});
		let removed = 0;
		if (canDeleteAll) {
			for (const delta of deltas) {
				await ctx.db.delete(delta._id);
				removed++;
			}
			logger.info("Full compaction completed", {
				document: args.document,
				removed,
				size: merged.byteLength
			});
		} else logger.info("Snapshot created, deltas retained (clients still syncing)", {
			document: args.document,
			deltaCount: deltas.length,
			activeCount: sessions$1.length
		});
		const disconnected = await ctx.db.query("sessions").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).filter((q) => q.eq(q.field("connected"), false)).collect();
		let cleaned = 0;
		for (const session of disconnected) {
			if (!session.vector) {
				await ctx.db.delete(session._id);
				cleaned++;
				continue;
			}
			const sessionVector = new Uint8Array(session.vector);
			if (Y.diffUpdateV2(merged, sessionVector).byteLength <= 2) {
				await ctx.db.delete(session._id);
				cleaned++;
			}
		}
		if (cleaned > 0) logger.info("Cleaned up disconnected sessions", {
			document: args.document,
			cleaned
		});
		return {
			success: true,
			removed,
			retained: deltas.length - removed,
			size: merged.byteLength
		};
	}
});
const stream = query({
	args: {
		collection: v.string(),
		seq: v.number(),
		limit: v.optional(v.number()),
		threshold: v.optional(v.number())
	},
	returns: v.object({
		changes: v.array(v.object({
			document: v.string(),
			bytes: v.bytes(),
			seq: v.number(),
			type: v.string()
		})),
		seq: v.number(),
		more: v.boolean(),
		compact: v.optional(v.object({ documents: v.array(v.string()) }))
	}),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 100;
		const threshold = args.threshold ?? DEFAULT_DELTA_COUNT_THRESHOLD;
		const documents = await ctx.db.query("documents").withIndex("by_seq", (q) => q.eq("collection", args.collection).gt("seq", args.seq)).order("asc").take(limit);
		if (documents.length > 0) {
			const changes = documents.map((doc) => ({
				document: doc.document,
				bytes: doc.bytes,
				seq: doc.seq,
				type: OperationType.Delta
			}));
			const newSeq = documents[documents.length - 1]?.seq ?? args.seq;
			const allDocs = await ctx.db.query("documents").withIndex("by_collection", (q) => q.eq("collection", args.collection)).collect();
			const countByDoc = /* @__PURE__ */ new Map();
			for (const doc of allDocs) {
				const current = countByDoc.get(doc.document) ?? 0;
				countByDoc.set(doc.document, current + 1);
			}
			const documentsNeedingCompaction = [];
			for (const [docId, count] of countByDoc) if (count >= threshold) documentsNeedingCompaction.push(docId);
			return {
				changes,
				seq: newSeq,
				more: documents.length === limit,
				compact: documentsNeedingCompaction.length > 0 ? { documents: documentsNeedingCompaction } : void 0
			};
		}
		const oldest = await ctx.db.query("documents").withIndex("by_seq", (q) => q.eq("collection", args.collection)).order("asc").first();
		if (oldest && args.seq < oldest.seq) {
			const snapshots = await ctx.db.query("snapshots").withIndex("by_document", (q) => q.eq("collection", args.collection)).collect();
			if (snapshots.length === 0) throw new Error(`Disparity detected but no snapshots available for collection: ${args.collection}. Client seq: ${args.seq}, Oldest delta seq: ${oldest.seq}`);
			return {
				changes: snapshots.map((s) => ({
					document: s.document,
					bytes: s.bytes,
					seq: s.seq,
					type: OperationType.Snapshot
				})),
				seq: Math.max(...snapshots.map((s) => s.seq)),
				more: false,
				compact: void 0
			};
		}
		return {
			changes: [],
			seq: args.seq,
			more: false,
			compact: void 0
		};
	}
});
const recovery = query({
	args: {
		collection: v.string(),
		document: v.string(),
		vector: v.bytes()
	},
	returns: v.object({
		diff: v.optional(v.bytes()),
		vector: v.bytes()
	}),
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.query("snapshots").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).first();
		const deltas = await ctx.db.query("documents").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).collect();
		if (!snapshot && deltas.length === 0) {
			const emptyDoc = new Y.Doc();
			const emptyVector = Y.encodeStateVector(emptyDoc);
			emptyDoc.destroy();
			return { vector: emptyVector.buffer };
		}
		const updates = [];
		if (snapshot) updates.push(new Uint8Array(snapshot.bytes));
		for (const delta of deltas) updates.push(new Uint8Array(delta.bytes));
		const merged = Y.mergeUpdatesV2(updates);
		const clientVector = new Uint8Array(args.vector);
		const diff = Y.diffUpdateV2(merged, clientVector);
		const serverVector = Y.encodeStateVectorFromUpdateV2(merged);
		return {
			diff: diff.byteLength > 0 ? diff.buffer : void 0,
			vector: serverVector.buffer
		};
	}
});
const getDocumentState = query({
	args: {
		collection: v.string(),
		document: v.string()
	},
	returns: v.union(v.object({
		bytes: v.bytes(),
		seq: v.number()
	}), v.null()),
	handler: async (ctx, args) => {
		const snapshot = await ctx.db.query("snapshots").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).first();
		const deltas = await ctx.db.query("documents").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document)).collect();
		if (!snapshot && deltas.length === 0) return null;
		const updates = [];
		let latestSeq = 0;
		if (snapshot) {
			updates.push(new Uint8Array(snapshot.bytes));
			latestSeq = Math.max(latestSeq, snapshot.seq);
		}
		for (const delta of deltas) {
			updates.push(new Uint8Array(delta.bytes));
			latestSeq = Math.max(latestSeq, delta.seq);
		}
		return {
			bytes: Y.mergeUpdatesV2(updates).buffer,
			seq: latestSeq
		};
	}
});
const sessions = query({
	args: {
		collection: v.string(),
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
		let query$1 = ctx.db.query("sessions").withIndex("by_document", (q) => q.eq("collection", args.collection).eq("document", args.document));
		if (args.connected !== void 0) query$1 = query$1.filter((q) => q.eq(q.field("connected"), args.connected));
		let results = (await query$1.collect()).filter((p) => !args.exclude || p.client !== args.exclude).map((p) => ({
			client: p.client,
			document: p.document,
			user: p.user,
			profile: p.profile,
			cursor: p.cursor,
			seen: p.seen
		}));
		if (args.group) {
			const byUser = /* @__PURE__ */ new Map();
			for (const p of results) {
				const key = p.user ?? p.client;
				const existing = byUser.get(key);
				if (!existing || p.seen > existing.seen) byUser.set(key, p);
			}
			results = Array.from(byUser.values());
		}
		return results;
	}
});
const disconnect = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		client: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db.query("sessions").withIndex("by_client", (q) => q.eq("collection", args.collection).eq("document", args.document).eq("client", args.client)).first();
		if (existing) await ctx.db.patch(existing._id, {
			connected: false,
			cursor: void 0,
			timeout: void 0
		});
		return null;
	}
});
const presence = mutation({
	args: {
		collection: v.string(),
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
		const existing = await ctx.db.query("sessions").withIndex("by_client", (q) => q.eq("collection", args.collection).eq("document", args.document).eq("client", args.client)).first();
		if (args.action === "leave") {
			if (existing?.timeout) await ctx.scheduler.cancel(existing.timeout);
			if (existing) await ctx.db.patch(existing._id, {
				connected: false,
				cursor: void 0,
				timeout: void 0
			});
			return null;
		}
		const now = Date.now();
		const interval = args.interval ?? DEFAULT_HEARTBEAT_INTERVAL;
		if (existing?.timeout) await ctx.scheduler.cancel(existing.timeout);
		const timeout = await ctx.scheduler.runAfter(interval * 2.5, api.mutations.disconnect, {
			collection: args.collection,
			document: args.document,
			client: args.client
		});
		const updates = {
			connected: true,
			seen: now,
			timeout
		};
		if (args.user !== void 0) updates.user = args.user;
		if (args.profile !== void 0) updates.profile = args.profile;
		if (args.cursor !== void 0) updates.cursor = args.cursor;
		if (args.vector !== void 0) updates.vector = args.vector;
		if (existing) await ctx.db.patch(existing._id, updates);
		else await ctx.db.insert("sessions", {
			collection: args.collection,
			document: args.document,
			client: args.client,
			connected: true,
			seq: 0,
			seen: now,
			user: args.user,
			profile: args.profile,
			cursor: args.cursor,
			vector: args.vector,
			timeout
		});
		return null;
	}
});

//#endregion
export { OperationType, compact, deleteDocument, disconnect, getDocumentState, insertDocument, mark, presence, recovery, sessions, stream, updateDocument };