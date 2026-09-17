import * as Y from 'yjs';
import { v, ConvexError } from 'convex/values';
import { mutation, query, type MutationCtx } from '$/component/_generated/server';
import { api } from '$/component/_generated/api';
import { getLogger } from '$/shared/logger';
import { OperationType } from '$/shared';
import {
	profileValidator,
	cursorValidator,
	streamResultValidator,
	sessionValidator,
	presenceActionValidator,
	successSeqValidator,
	compactResultValidator,
	recoveryResultValidator,
	documentStateValidator,
} from '$/shared';

export { OperationType };

const DEFAULT_THRESHOLD = 500;
const DEFAULT_TIMEOUT = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;

/**
 * Atomic sequence generation using dedicated counter table.
 *
 * This pattern leverages Convex's OCC (Optimistic Concurrency Control):
 * - If two mutations try to increment the same counter concurrently,
 *   Convex detects the conflict and retries one of them automatically.
 * - This guarantees unique, monotonically increasing sequence numbers.
 *
 * Previous approach (querying max seq from deltas table) had a race condition
 * where concurrent mutations could get the same seq number.
 */
async function getNextSeq(ctx: MutationCtx, collection: string): Promise<number> {
	const existing = await ctx.db
		.query('sequences')
		.withIndex('by_collection', (q) => q.eq('collection', collection))
		.unique();

	// Include snapshots even when a legacy counter exists below their boundary.
	const latestDelta = await ctx.db
		.query('deltas')
		.withIndex('by_seq', (q) => q.eq('collection', collection))
		.order('desc')
		.first();
	const latestSnapshot = await ctx.db
		.query('snapshots')
		.withIndex('by_seq', (q) => q.eq('collection', collection))
		.order('desc')
		.first();
	const seq = Math.max(existing?.seq ?? 0, latestDelta?.seq ?? 0, latestSnapshot?.seq ?? 0) + 1;
	if (existing) await ctx.db.patch(existing._id, { seq });
	else await ctx.db.insert('sequences', { collection, seq });
	return seq;
}

// O(1) delta count increment - called when inserting a delta
async function incrementDeltaCount(
	ctx: MutationCtx,
	collection: string,
	document: string
): Promise<number> {
	const existing = await ctx.db
		.query('deltaCounts')
		.withIndex('by_document', (q) => q.eq('collection', collection).eq('document', document))
		.first();

	if (existing) {
		const newCount = existing.count + 1;
		await ctx.db.patch(existing._id, { count: newCount });
		return newCount;
	}

	await ctx.db.insert('deltaCounts', { collection, document, count: 1 });
	return 1;
}

// O(1) delta count decrement - called when compaction deletes deltas
async function decrementDeltaCount(
	ctx: MutationCtx,
	collection: string,
	document: string,
	amount: number
): Promise<void> {
	const existing = await ctx.db
		.query('deltaCounts')
		.withIndex('by_document', (q) => q.eq('collection', collection).eq('document', document))
		.first();

	if (existing) {
		const newCount = Math.max(0, existing.count - amount);
		await ctx.db.patch(existing._id, { count: newCount });
	}
}

// O(1) compaction threshold check using cached count
async function scheduleCompactionIfNeeded(
	ctx: MutationCtx,
	collection: string,
	document: string,
	currentCount: number,
	threshold: number = DEFAULT_THRESHOLD,
	timeout: number = DEFAULT_TIMEOUT,
	retain: number = 0
): Promise<void> {
	if (currentCount >= threshold) {
		await ctx.runMutation(api.mutations.scheduleCompaction, {
			collection,
			document,
			timeout,
			retain,
		});
	}
}

const documentWriteArgs = {
	collection: v.string(),
	document: v.string(),
	bytes: v.bytes(),
	threshold: v.optional(v.number()),
	timeout: v.optional(v.number()),
	retain: v.optional(v.number()),
};

async function handleDocumentWrite(
	ctx: MutationCtx,
	args: {
		collection: string;
		document: string;
		bytes: ArrayBuffer;
		threshold?: number;
		timeout?: number;
		retain?: number;
	}
) {
	const seq = await getNextSeq(ctx, args.collection);

	await ctx.db.insert('deltas', {
		collection: args.collection,
		document: args.document,
		bytes: args.bytes,
		seq,
	});

	const count = await incrementDeltaCount(ctx, args.collection, args.document);
	await scheduleCompactionIfNeeded(
		ctx,
		args.collection,
		args.document,
		count,
		args.threshold ?? DEFAULT_THRESHOLD,
		args.timeout ?? DEFAULT_TIMEOUT,
		args.retain ?? 0
	);

	return { success: true as const, seq };
}

export const insertDocument = mutation({
	args: documentWriteArgs,
	returns: successSeqValidator,
	handler: handleDocumentWrite,
});

export const updateDocument = mutation({
	args: documentWriteArgs,
	returns: successSeqValidator,
	handler: handleDocumentWrite,
});

export const deleteDocument = mutation({
	args: documentWriteArgs,
	returns: successSeqValidator,
	handler: handleDocumentWrite,
});

const DEFAULT_HEARTBEAT_INTERVAL = 10000;

export const mark = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		client: v.string(),
		vector: v.optional(v.bytes()),
		seq: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();

		const existing = await ctx.db
			.query('sessions')
			.withIndex('by_client', (q) =>
				q.eq('collection', args.collection).eq('document', args.document).eq('client', args.client)
			)
			.first();

		const updates: Record<string, unknown> = {
			seen: now,
		};

		if (args.vector !== undefined) updates.vector = args.vector;
		// Idempotent seq update: only update if new seq is strictly greater
		// This prevents race conditions where a lower seq overwrites a higher one
		if (args.seq !== undefined && (!existing || args.seq > existing.seq)) {
			updates.seq = args.seq;
		}

		if (existing) {
			await ctx.db.patch(existing._id, updates);
		} else {
			await ctx.db.insert('sessions', {
				collection: args.collection,
				document: args.document,
				client: args.client,
				vector: args.vector,
				connected: false,
				seq: args.seq ?? 0,
				seen: now,
			});
		}

		return null;
	},
});

export const compact = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
	},
	returns: compactResultValidator,
	handler: async (ctx, args) => {
		const logger = getLogger(['compaction']);
		const now = Date.now();

		// Query all deltas for this document
		const allDeltas = await ctx.db
			.query('deltas')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.collect();

		// Convex mutations read a consistent transactional snapshot.
		const deltas = allDeltas;

		if (deltas.length === 0) {
			return { success: true, removed: 0, retained: 0, size: 0 };
		}

		const existing = await ctx.db
			.query('snapshots')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.first();

		const updates: Uint8Array[] = [];
		if (existing) {
			updates.push(new Uint8Array(existing.bytes));
		}
		updates.push(...deltas.map((d) => new Uint8Array(d.bytes)));

		const merged = Y.mergeUpdatesV2(updates);
		const vector = Y.encodeStateVectorFromUpdateV2(merged);

		const sessions = await ctx.db
			.query('sessions')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.filter((q) => q.eq(q.field('connected'), true))
			.collect();

		let canDeleteAll = true;
		for (const session of sessions) {
			if (!session.vector) {
				canDeleteAll = false;
				logger.warn('Session without vector, skipping full compaction', {
					client: session.client,
				});
				break;
			}

			const sessionVector = new Uint8Array(session.vector);
			const missing = Y.diffUpdateV2(merged, sessionVector);

			if (missing.byteLength > 2) {
				canDeleteAll = false;
				logger.debug('Session still needs data', {
					client: session.client,
					missingSize: missing.byteLength,
				});
				break;
			}
		}

		// Publish a fresh position atomically with replacement and delta removal.
		const seq = await getNextSeq(ctx, args.collection);

		if (existing) {
			await ctx.db.patch(existing._id, {
				bytes: merged.buffer as ArrayBuffer,
				vector: vector.buffer as ArrayBuffer,
				seq,
				publication: 1,
				created: now,
			});
		} else {
			await ctx.db.insert('snapshots', {
				collection: args.collection,
				document: args.document,
				bytes: merged.buffer as ArrayBuffer,
				vector: vector.buffer as ArrayBuffer,
				seq,
				publication: 1,
				created: now,
			});
		}

		let removed = 0;
		if (canDeleteAll) {
			for (const delta of deltas) {
				await ctx.db.delete(delta._id);
				removed++;
			}

			// Decrement delta count to keep it in sync
			if (removed > 0) {
				await decrementDeltaCount(ctx, args.collection, args.document, removed);
			}

			logger.info('Full compaction completed', {
				document: args.document,
				removed,
				size: merged.byteLength,
			});
		} else {
			logger.info('Snapshot created, deltas retained (clients still syncing)', {
				document: args.document,
				deltaCount: deltas.length,
				activeCount: sessions.length,
			});
		}

		const disconnected = await ctx.db
			.query('sessions')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.filter((q) => q.eq(q.field('connected'), false))
			.collect();

		let cleaned = 0;
		for (const session of disconnected) {
			if (!session.vector) {
				await ctx.db.delete(session._id);
				cleaned++;
				continue;
			}

			const sessionVector = new Uint8Array(session.vector);
			const missing = Y.diffUpdateV2(merged, sessionVector);

			if (missing.byteLength <= 2) {
				await ctx.db.delete(session._id);
				cleaned++;
			}
		}

		if (cleaned > 0) {
			logger.info('Cleaned up disconnected sessions', {
				document: args.document,
				cleaned,
			});
		}

		return {
			success: true,
			removed,
			retained: deltas.length - removed,
			size: merged.byteLength,
		};
	},
});

export const scheduleCompaction = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		timeout: v.optional(v.number()),
		retain: v.optional(v.number()),
	},
	returns: v.object({
		id: v.optional(v.id('compaction')),
		status: v.union(
			v.literal('scheduled'),
			v.literal('already_running'),
			v.literal('already_pending')
		),
	}),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('compaction')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document).eq('status', 'running')
			)
			.first();

		if (existing) {
			return { id: existing._id, status: 'already_running' as const };
		}

		const pending = await ctx.db
			.query('compaction')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document).eq('status', 'pending')
			)
			.first();

		if (pending) {
			return { id: pending._id, status: 'already_pending' as const };
		}

		const id = await ctx.db.insert('compaction', {
			collection: args.collection,
			document: args.document,
			status: 'pending',
			started: Date.now(),
			retries: 0,
		});

		await ctx.scheduler.runAfter(0, api.mutations.runCompaction, {
			id,
			timeout: args.timeout,
			retain: args.retain,
		});

		return { id, status: 'scheduled' as const };
	},
});

export const runCompaction = mutation({
	args: {
		id: v.id('compaction'),
		timeout: v.optional(v.number()),
		retain: v.optional(v.number()),
	},
	returns: v.union(v.null(), v.object({ removed: v.number(), retained: v.number() })),
	handler: async (ctx, args) => {
		const logger = getLogger(['compaction']);
		const job = await ctx.db.get(args.id);

		if (!job || job.status === 'done') {
			return null;
		}

		await ctx.db.patch(args.id, { status: 'running' });

		const now = Date.now();
		const timeout = args.timeout ?? DEFAULT_TIMEOUT;
		const retain = args.retain ?? 0;

		try {
			const allDeltas = await ctx.db
				.query('deltas')
				.withIndex('by_document', (q) =>
					q.eq('collection', job.collection).eq('document', job.document)
				)
				.collect();

			// Convex mutations read a consistent transactional snapshot.
			const deltas = allDeltas;

			if (deltas.length === 0) {
				await ctx.db.patch(args.id, { status: 'done', completed: now });
				return { removed: 0, retained: 0 };
			}

			const snapshot = await ctx.db
				.query('snapshots')
				.withIndex('by_document', (q) =>
					q.eq('collection', job.collection).eq('document', job.document)
				)
				.first();

			const updates: Uint8Array[] = [];
			if (snapshot) {
				updates.push(new Uint8Array(snapshot.bytes));
			}
			updates.push(...deltas.map((d) => new Uint8Array(d.bytes)));

			const merged = Y.mergeUpdatesV2(updates);
			const vector = Y.encodeStateVectorFromUpdateV2(merged);

			const sessions = await ctx.db
				.query('sessions')
				.withIndex('by_document', (q) =>
					q.eq('collection', job.collection).eq('document', job.document)
				)
				.collect();

			let canDeleteAll = true;
			for (const session of sessions) {
				const isActive = session.connected || now - session.seen < timeout;
				if (!isActive) continue;

				if (!session.vector) {
					canDeleteAll = false;
					logger.warn('Active session without vector, skipping full compaction', {
						client: session.client,
					});
					break;
				}

				const sessionVector = new Uint8Array(session.vector);
				const missing = Y.diffUpdateV2(merged, sessionVector);

				if (missing.byteLength > 2) {
					canDeleteAll = false;
					logger.debug('Active session still needs data', {
						client: session.client,
						missingSize: missing.byteLength,
					});
					break;
				}
			}

			// Publish a fresh position atomically with replacement and delta removal.
			const seq = await getNextSeq(ctx, job.collection);

			if (snapshot) {
				await ctx.db.patch(snapshot._id, {
					bytes: merged.buffer as ArrayBuffer,
					vector: vector.buffer as ArrayBuffer,
					seq,
					publication: 1,
					created: now,
				});
			} else {
				await ctx.db.insert('snapshots', {
					collection: job.collection,
					document: job.document,
					bytes: merged.buffer as ArrayBuffer,
					vector: vector.buffer as ArrayBuffer,
					seq,
					publication: 1,
					created: now,
				});
			}

			let removed = 0;
			if (canDeleteAll) {
				const sortedDeltas = [...deltas].sort((a, b) => b.seq - a.seq);
				const deltasToRetain = sortedDeltas.slice(0, retain);
				const deltasToDelete = sortedDeltas.slice(retain);
				const retainIds = new Set(deltasToRetain.map((d) => d._id));

				for (const delta of deltasToDelete) {
					if (!retainIds.has(delta._id)) {
						await ctx.db.delete(delta._id);
						removed++;
					}
				}

				// Decrement delta count to keep it in sync
				if (removed > 0) {
					await decrementDeltaCount(ctx, job.collection, job.document, removed);
				}

				logger.info('Compaction completed', {
					document: job.document,
					removed,
					retained: deltasToRetain.length,
					size: merged.byteLength,
				});
			} else {
				logger.info('Snapshot created, deltas retained (clients still syncing)', {
					document: job.document,
					deltaCount: deltas.length,
					activeCount: sessions.filter((s) => s.connected || now - s.seen < timeout).length,
				});
			}

			for (const session of sessions) {
				if (session.connected) continue;
				if (now - session.seen > timeout) {
					await ctx.db.delete(session._id);
					logger.debug('Cleaned up stale session', { client: session.client });
				}
			}

			await ctx.db.patch(args.id, { status: 'done', completed: now });
			return { removed, retained: deltas.length - removed };
		} catch (error) {
			const retries = (job.retries ?? 0) + 1;

			if (retries < MAX_RETRIES) {
				await ctx.db.patch(args.id, { status: 'pending', retries });
				const backoff = Math.pow(2, retries) * 1000;
				await ctx.scheduler.runAfter(backoff, api.mutations.runCompaction, {
					id: args.id,
					timeout: args.timeout,
					retain: args.retain,
				});
				logger.warn('Compaction failed, scheduling retry', {
					document: job.document,
					retries,
					backoff,
				});
			} else {
				await ctx.db.patch(args.id, {
					status: 'failed',
					error: String(error),
					completed: now,
				});
				logger.error('Compaction failed after max retries', {
					document: job.document,
					error: String(error),
				});
			}
			throw error;
		}
	},
});

/** Republish legacy snapshots in bounded, atomic, restartable batches.
 * Call from an application internal mutation until done before enabling streaming.
 */
export const migrateSnapshots = mutation({
	args: { collection: v.string(), limit: v.optional(v.number()) },
	returns: v.object({ migrated: v.number(), done: v.boolean() }),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new ConvexError('Migration limit must be an integer between 1 and 100');
		}
		const legacy = await ctx.db
			.query('snapshots')
			.withIndex('by_publication', (q) =>
				q.eq('collection', args.collection).eq('publication', undefined)
			)
			.take(limit + 1);
		for (const snapshot of legacy.slice(0, limit)) {
			const seq = await getNextSeq(ctx, args.collection);
			await ctx.db.patch(snapshot._id, { seq, publication: 1 });
		}
		return { migrated: Math.min(limit, legacy.length), done: legacy.length <= limit };
	},
});

export const stream = query({
	args: {
		collection: v.string(),
		seq: v.number(),
		limit: v.optional(v.number()),
		threshold: v.optional(v.number()),
	},
	returns: streamResultValidator,
	handler: async (ctx, args) => {
		const limit = args.limit ?? 100;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
			throw new ConvexError('Stream limit must be an integer between 1 and 1000');
		}
		const legacy = await ctx.db
			.query('snapshots')
			.withIndex('by_publication', (q) =>
				q.eq('collection', args.collection).eq('publication', undefined)
			)
			.first();
		if (legacy)
			throw new ConvexError('Snapshot migration required: run migrateSnapshots until done');
		const deltas = await ctx.db
			.query('deltas')
			.withIndex('by_seq', (q) => q.eq('collection', args.collection).gt('seq', args.seq))
			.order('asc')
			.take(limit + 1);
		const snapshots = await ctx.db
			.query('snapshots')
			.withIndex('by_seq', (q) => q.eq('collection', args.collection).gt('seq', args.seq))
			.order('asc')
			.take(limit + 1);
		const candidates = [
			...deltas.map((d) => ({
				document: d.document,
				bytes: d.bytes,
				seq: d.seq,
				type: OperationType.Delta,
			})),
			...snapshots.map((d) => ({
				document: d.document,
				bytes: d.bytes,
				seq: d.seq,
				type: OperationType.Snapshot,
			})),
		].sort((a, b) => a.seq - b.seq);
		const changes = candidates.slice(0, limit);
		return {
			changes,
			seq: changes.at(-1)?.seq ?? args.seq,
			more: candidates.length > limit,
			compact: undefined,
		};
	},
});

export const recovery = query({
	args: {
		collection: v.string(),
		document: v.string(),
		vector: v.bytes(),
	},
	returns: recoveryResultValidator,
	handler: async (ctx, args) => {
		const snapshot = await ctx.db
			.query('snapshots')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.first();

		const deltas = await ctx.db
			.query('deltas')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.collect();

		if (!snapshot && deltas.length === 0) {
			const emptyDoc = new Y.Doc();
			const emptyVector = Y.encodeStateVector(emptyDoc);
			emptyDoc.destroy();
			return {
				vector: emptyVector.buffer as ArrayBuffer,
				known: false,
			};
		}

		const updates: Uint8Array[] = [];

		if (snapshot) {
			updates.push(new Uint8Array(snapshot.bytes));
		}

		for (const delta of deltas) {
			updates.push(new Uint8Array(delta.bytes));
		}

		const merged = Y.mergeUpdatesV2(updates);
		const clientVector = new Uint8Array(args.vector);
		const diff = Y.diffUpdateV2(merged, clientVector);
		const serverVector = Y.encodeStateVectorFromUpdateV2(merged);

		return {
			diff: diff.byteLength > 0 ? (diff.buffer as ArrayBuffer) : undefined,
			vector: serverVector.buffer as ArrayBuffer,
			known: true,
		};
	},
});

export const getDocumentState = query({
	args: {
		collection: v.string(),
		document: v.string(),
	},
	returns: documentStateValidator,
	handler: async (ctx, args) => {
		const snapshot = await ctx.db
			.query('snapshots')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.first();

		const deltas = await ctx.db
			.query('deltas')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			)
			.collect();

		if (!snapshot && deltas.length === 0) {
			return null;
		}

		const updates: Uint8Array[] = [];
		let latestSeq = 0;

		if (snapshot) {
			updates.push(new Uint8Array(snapshot.bytes));
			latestSeq = Math.max(latestSeq, snapshot.seq);
		}

		for (const delta of deltas) {
			updates.push(new Uint8Array(delta.bytes));
			latestSeq = Math.max(latestSeq, delta.seq);
		}

		const merged = Y.mergeUpdatesV2(updates);

		return {
			bytes: merged.buffer as ArrayBuffer,
			seq: latestSeq,
		};
	},
});

export const sessions = query({
	args: {
		collection: v.string(),
		document: v.string(),
		connected: v.optional(v.boolean()),
		exclude: v.optional(v.string()),
	},
	returns: v.array(sessionValidator),
	handler: async (ctx, args) => {
		let sessionsQuery = ctx.db
			.query('sessions')
			.withIndex('by_document', (q) =>
				q.eq('collection', args.collection).eq('document', args.document)
			);

		if (args.connected !== undefined) {
			sessionsQuery = sessionsQuery.filter((q) => q.eq(q.field('connected'), args.connected));
		}

		const records = await sessionsQuery.collect();

		const mapped = records
			.filter((p) => !args.exclude || p.client !== args.exclude)
			.map((p) => ({
				client: p.client,
				document: p.document,
				user: p.user,
				profile: p.profile,
				cursor: p.cursor,
				seen: p.seen,
			}));

		const byUser = new Map<string, (typeof mapped)[0]>();
		for (const p of mapped) {
			const key = p.user ?? p.client;
			const existing = byUser.get(key);
			if (!existing || p.seen > existing.seen) {
				byUser.set(key, p);
			}
		}

		return Array.from(byUser.values());
	},
});

export const disconnect = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		client: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('sessions')
			.withIndex('by_client', (q) =>
				q.eq('collection', args.collection).eq('document', args.document).eq('client', args.client)
			)
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, {
				connected: false,
				cursor: undefined,
				timeout: undefined,
			});
		}

		return null;
	},
});

export const presence = mutation({
	args: {
		collection: v.string(),
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
		const existing = await ctx.db
			.query('sessions')
			.withIndex('by_client', (q) =>
				q.eq('collection', args.collection).eq('document', args.document).eq('client', args.client)
			)
			.first();

		if (args.action === 'leave') {
			if (existing?.timeout) {
				await ctx.scheduler.cancel(existing.timeout);
			}
			if (existing) {
				await ctx.db.patch(existing._id, {
					connected: false,
					cursor: undefined,
					timeout: undefined,
				});
			}
			return null;
		}

		const now = Date.now();
		const interval = args.interval ?? DEFAULT_HEARTBEAT_INTERVAL;

		if (existing?.timeout) {
			await ctx.scheduler.cancel(existing.timeout);
		}

		const timeout = await ctx.scheduler.runAfter(interval * 2.5, api.mutations.disconnect, {
			collection: args.collection,
			document: args.document,
			client: args.client,
		});

		const updates: Record<string, unknown> = {
			connected: true,
			seen: now,
			timeout,
		};

		if (args.user !== undefined) updates.user = args.user;
		if (args.profile !== undefined) updates.profile = args.profile;
		if (args.cursor !== undefined) updates.cursor = args.cursor;
		if (args.vector !== undefined) updates.vector = args.vector;

		if (existing) {
			await ctx.db.patch(existing._id, updates);
		} else {
			await ctx.db.insert('sessions', {
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
				timeout,
			});
		}

		return null;
	},
});
