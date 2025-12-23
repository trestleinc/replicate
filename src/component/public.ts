import * as Y from "yjs";
import { v } from "convex/values";
import { mutation, query } from "$/component/_generated/server";
import { getLogger } from "$/component/logger";
import { OperationType } from "$/shared/types";

export { OperationType };

const DEFAULT_SIZE_THRESHOLD = 5_000_000;
const DEFAULT_PEER_TIMEOUT = 5 * 60 * 1000;

async function getNextSeq(ctx: any, collection: string): Promise<number> {
  const latest = await ctx.db
    .query("documents")
    .withIndex("by_seq", (q: any) => q.eq("collection", collection))
    .order("desc")
    .first();
  return (latest?.seq ?? 0) + 1;
}

export const insertDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
  },
  returns: v.object({
    success: v.boolean(),
    seq: v.number(),
  }),
  handler: async (ctx, args) => {
    const seq = await getNextSeq(ctx, args.collection);

    await ctx.db.insert("documents", {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      seq,
    });

    return { success: true, seq };
  },
});

export const updateDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
  },
  returns: v.object({
    success: v.boolean(),
    seq: v.number(),
  }),
  handler: async (ctx, args) => {
    const seq = await getNextSeq(ctx, args.collection);

    await ctx.db.insert("documents", {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      seq,
    });

    return { success: true, seq };
  },
});

export const deleteDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
  },
  returns: v.object({
    success: v.boolean(),
    seq: v.number(),
  }),
  handler: async (ctx, args) => {
    const seq = await getNextSeq(ctx, args.collection);

    await ctx.db.insert("documents", {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      seq,
    });

    return { success: true, seq };
  },
});

export const ack = mutation({
  args: {
    collection: v.string(),
    peerId: v.string(),
    syncedSeq: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("peers")
      .withIndex("by_collection_peer", (q: any) =>
        q.eq("collection", args.collection).eq("peerId", args.peerId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastSyncedSeq: Math.max(existing.lastSyncedSeq, args.syncedSeq),
        lastSeenAt: Date.now(),
      });
    }
    else {
      await ctx.db.insert("peers", {
        collection: args.collection,
        peerId: args.peerId,
        lastSyncedSeq: args.syncedSeq,
        lastSeenAt: Date.now(),
      });
    }

    return null;
  },
});

export const compact = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    snapshotBytes: v.bytes(),
    stateVector: v.bytes(),
    peerTimeout: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    removed: v.number(),
    retained: v.number(),
  }),
  handler: async (ctx, args) => {
    const logger = getLogger(["compaction"]);
    const now = Date.now();
    const peerTimeout = args.peerTimeout ?? DEFAULT_PEER_TIMEOUT;
    const peerCutoff = now - peerTimeout;

    const deltas = await ctx.db
      .query("documents")
      .withIndex("by_collection_document", (q: any) =>
        q.eq("collection", args.collection).eq("documentId", args.documentId),
      )
      .collect();

    const activePeers = await ctx.db
      .query("peers")
      .withIndex("by_collection", (q: any) => q.eq("collection", args.collection))
      .filter((q: any) => q.gt(q.field("lastSeenAt"), peerCutoff))
      .collect();

    const minSyncedSeq = activePeers.length > 0
      ? Math.min(...activePeers.map((p: any) => p.lastSyncedSeq))
      : Infinity;

    const existingSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_document", (q: any) =>
        q.eq("collection", args.collection).eq("documentId", args.documentId),
      )
      .first();

    if (existingSnapshot) {
      await ctx.db.delete(existingSnapshot._id);
    }

    const snapshotSeq = deltas.length > 0
      ? Math.max(...deltas.map((d: any) => d.seq))
      : 0;

    await ctx.db.insert("snapshots", {
      collection: args.collection,
      documentId: args.documentId,
      snapshotBytes: args.snapshotBytes,
      stateVector: args.stateVector,
      snapshotSeq,
      createdAt: now,
    });

    let removed = 0;
    for (const delta of deltas) {
      if (delta.seq < minSyncedSeq) {
        await ctx.db.delete(delta._id);
        removed++;
      }
    }

    logger.info("Compaction completed", {
      collection: args.collection,
      documentId: args.documentId,
      removed,
      retained: deltas.length - removed,
      activePeers: activePeers.length,
      minSyncedSeq,
    });

    return { success: true, removed, retained: deltas.length - removed };
  },
});

export const stream = query({
  args: {
    collection: v.string(),
    cursor: v.number(),
    limit: v.optional(v.number()),
    sizeThreshold: v.optional(v.number()),
  },
  returns: v.object({
    changes: v.array(
      v.object({
        documentId: v.string(),
        crdtBytes: v.bytes(),
        seq: v.number(),
        operationType: v.string(),
      }),
    ),
    cursor: v.number(),
    hasMore: v.boolean(),
    compact: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const sizeThreshold = args.sizeThreshold ?? DEFAULT_SIZE_THRESHOLD;

    const documents = await ctx.db
      .query("documents")
      .withIndex("by_seq", (q: any) =>
        q.eq("collection", args.collection).gt("seq", args.cursor),
      )
      .order("asc")
      .take(limit);

    if (documents.length > 0) {
      const changes = documents.map((doc: any) => ({
        documentId: doc.documentId,
        crdtBytes: doc.crdtBytes,
        seq: doc.seq,
        operationType: OperationType.Delta,
      }));

      const newCursor = documents[documents.length - 1]?.seq ?? args.cursor;

      let compactHint: string | undefined;
      const allDocs = await ctx.db
        .query("documents")
        .withIndex("by_collection", (q: any) => q.eq("collection", args.collection))
        .collect();

      const sizeByDocument = new Map<string, number>();
      for (const doc of allDocs) {
        const current = sizeByDocument.get(doc.documentId) ?? 0;
        sizeByDocument.set(doc.documentId, current + doc.crdtBytes.byteLength);
      }

      for (const [docId, size] of sizeByDocument) {
        if (size > sizeThreshold) {
          compactHint = docId;
          break;
        }
      }

      return {
        changes,
        cursor: newCursor,
        hasMore: documents.length === limit,
        compact: compactHint,
      };
    }

    const oldestDelta = await ctx.db
      .query("documents")
      .withIndex("by_seq", (q: any) => q.eq("collection", args.collection))
      .order("asc")
      .first();

    if (oldestDelta && args.cursor < oldestDelta.seq) {
      const snapshots = await ctx.db
        .query("snapshots")
        .withIndex("by_document", (q: any) => q.eq("collection", args.collection))
        .collect();

      if (snapshots.length === 0) {
        throw new Error(
          `Disparity detected but no snapshots available for collection: ${args.collection}. `
          + `Client cursor: ${args.cursor}, Oldest delta seq: ${oldestDelta.seq}`,
        );
      }

      const changes = snapshots.map((snapshot: any) => ({
        documentId: snapshot.documentId,
        crdtBytes: snapshot.snapshotBytes,
        seq: snapshot.snapshotSeq,
        operationType: OperationType.Snapshot,
      }));

      const latestSeq = Math.max(...snapshots.map((s: any) => s.snapshotSeq));

      return {
        changes,
        cursor: latestSeq,
        hasMore: false,
        compact: undefined,
      };
    }

    return {
      changes: [],
      cursor: args.cursor,
      hasMore: false,
      compact: undefined,
    };
  },
});

export const getInitialState = query({
  args: {
    collection: v.string(),
  },
  returns: v.union(
    v.object({
      crdtBytes: v.bytes(),
      cursor: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const logger = getLogger(["ssr"]);

    const snapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_document", (q: any) => q.eq("collection", args.collection))
      .collect();

    const deltas = await ctx.db
      .query("documents")
      .withIndex("by_collection", (q: any) => q.eq("collection", args.collection))
      .collect();

    if (snapshots.length === 0 && deltas.length === 0) {
      logger.info("No initial state available - collection is empty", {
        collection: args.collection,
      });
      return null;
    }

    const updates: Uint8Array[] = [];
    let latestSeq = 0;

    for (const snapshot of snapshots) {
      updates.push(new Uint8Array(snapshot.snapshotBytes));
      latestSeq = Math.max(latestSeq, snapshot.snapshotSeq);
    }

    const sorted = deltas.sort((a: any, b: any) => a.seq - b.seq);
    for (const delta of sorted) {
      updates.push(new Uint8Array(delta.crdtBytes));
      latestSeq = Math.max(latestSeq, delta.seq);
    }

    logger.info("Reconstructing initial state", {
      collection: args.collection,
      snapshotCount: snapshots.length,
      deltaCount: deltas.length,
    });

    const merged = Y.mergeUpdatesV2(updates);

    logger.info("Initial state reconstructed", {
      collection: args.collection,
      originalSize: updates.reduce((sum, u) => sum + u.byteLength, 0),
      mergedSize: merged.byteLength,
    });

    return {
      crdtBytes: merged.buffer as ArrayBuffer,
      cursor: latestSeq,
    };
  },
});

export const recovery = query({
  args: {
    collection: v.string(),
    clientStateVector: v.bytes(),
  },
  returns: v.object({
    diff: v.optional(v.bytes()),
    serverStateVector: v.bytes(),
    cursor: v.number(),
  }),
  handler: async (ctx, args) => {
    const logger = getLogger(["recovery"]);

    const snapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_document", (q: any) => q.eq("collection", args.collection))
      .collect();

    const deltas = await ctx.db
      .query("documents")
      .withIndex("by_collection", (q: any) => q.eq("collection", args.collection))
      .collect();

    if (snapshots.length === 0 && deltas.length === 0) {
      const emptyDoc = new Y.Doc();
      const emptyVector = Y.encodeStateVector(emptyDoc);
      emptyDoc.destroy();
      return {
        serverStateVector: emptyVector.buffer as ArrayBuffer,
        cursor: 0,
      };
    }

    const updates: Uint8Array[] = [];
    let latestSeq = 0;

    for (const snapshot of snapshots) {
      updates.push(new Uint8Array(snapshot.snapshotBytes));
      latestSeq = Math.max(latestSeq, snapshot.snapshotSeq);
    }

    for (const delta of deltas) {
      updates.push(new Uint8Array(delta.crdtBytes));
      latestSeq = Math.max(latestSeq, delta.seq);
    }

    const mergedState = Y.mergeUpdatesV2(updates);
    const clientVector = new Uint8Array(args.clientStateVector);
    const diff = Y.diffUpdateV2(mergedState, clientVector);
    const serverVector = Y.encodeStateVectorFromUpdateV2(mergedState);

    logger.info("Recovery sync computed", {
      collection: args.collection,
      snapshotCount: snapshots.length,
      deltaCount: deltas.length,
      diffSize: diff.byteLength,
      hasDiff: diff.byteLength > 0,
    });

    return {
      diff: diff.byteLength > 0 ? (diff.buffer as ArrayBuffer) : undefined,
      serverStateVector: serverVector.buffer as ArrayBuffer,
      cursor: latestSeq,
    };
  },
});
