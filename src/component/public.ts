import * as Y from 'yjs';
import { v } from 'convex/values';
import { mutation, query } from '$/component/_generated/server';
import { getLogger } from '$/component/logger';
import { OperationType } from '$/shared/types.js';

export { OperationType };

// Default size threshold for auto-compaction (5MB)
const DEFAULT_SIZE_THRESHOLD = 5_000_000;

/**
 * Auto-compacts a document's deltas into a snapshot when size threshold is exceeded.
 * Returns null if no compaction needed, or the compaction result.
 */
async function _maybeCompactDocument(
  ctx: any,
  collection: string,
  documentId: string,
  threshold: number = DEFAULT_SIZE_THRESHOLD
): Promise<{ deltasCompacted: number; snapshotSize: number } | null> {
  const logger = getLogger(['compaction']);

  // Get all deltas for this specific document
  const deltas = await ctx.db
    .query('documents')
    .withIndex('by_collection_document_version', (q: any) =>
      q.eq('collection', collection).eq('documentId', documentId)
    )
    .collect();

  // Calculate total size
  const totalSize = deltas.reduce((sum: number, d: any) => sum + d.crdtBytes.byteLength, 0);

  // Skip if below size threshold
  if (totalSize < threshold) {
    return null;
  }

  logger.info('Auto-compacting document', {
    collection,
    documentId,
    deltaCount: deltas.length,
    totalSize,
    threshold,
  });

  // Merge deltas into snapshot
  const sorted = deltas.sort((a: any, b: any) => a.timestamp - b.timestamp);
  const updates = sorted.map((d: any) => new Uint8Array(d.crdtBytes));
  const compactedState = Y.mergeUpdatesV2(updates);

  // Validate compacted state
  const testDoc = new Y.Doc({ guid: `${collection}:${documentId}` });
  try {
    Y.applyUpdateV2(testDoc, compactedState);
  } catch (error) {
    logger.error('Compacted state validation failed', {
      collection,
      documentId,
      error: String(error),
    });
    testDoc.destroy();
    return null;
  }
  testDoc.destroy();

  // Delete existing snapshot for this document (keep only 1)
  const existingSnapshot = await ctx.db
    .query('snapshots')
    .withIndex('by_document', (q: any) =>
      q.eq('collection', collection).eq('documentId', documentId)
    )
    .first();
  if (existingSnapshot) {
    await ctx.db.delete('snapshots', existingSnapshot._id);
  }

  // Store new per-document snapshot
  await ctx.db.insert('snapshots', {
    collection,
    documentId,
    snapshotBytes: compactedState.buffer as ArrayBuffer,
    latestCompactionTimestamp: sorted[sorted.length - 1].timestamp,
    createdAt: Date.now(),
    metadata: {
      deltaCount: deltas.length,
      totalSize,
    },
  });

  // Delete old deltas
  for (const delta of sorted) {
    await ctx.db.delete('documents', delta._id);
  }

  logger.info('Auto-compaction completed', {
    collection,
    documentId,
    deltasCompacted: deltas.length,
    snapshotSize: compactedState.length,
  });

  return { deltasCompacted: deltas.length, snapshotSize: compactedState.length };
}

export const insertDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
    version: v.number(),
    threshold: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    compacted: v.optional(v.boolean()),
  }),
  handler: async (ctx, args) => {
    await ctx.db.insert('documents', {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      version: args.version,
      timestamp: Date.now(),
    });

    // Auto-compact if size threshold exceeded
    const compactionResult = await _maybeCompactDocument(
      ctx,
      args.collection,
      args.documentId,
      args.threshold ?? DEFAULT_SIZE_THRESHOLD
    );

    return {
      success: true,
      compacted: compactionResult !== null,
    };
  },
});

export const updateDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
    version: v.number(),
    threshold: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    compacted: v.optional(v.boolean()),
  }),
  handler: async (ctx, args) => {
    await ctx.db.insert('documents', {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      version: args.version,
      timestamp: Date.now(),
    });

    // Auto-compact if size threshold exceeded
    const compactionResult = await _maybeCompactDocument(
      ctx,
      args.collection,
      args.documentId,
      args.threshold ?? DEFAULT_SIZE_THRESHOLD
    );

    return {
      success: true,
      compacted: compactionResult !== null,
    };
  },
});

export const deleteDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
    version: v.number(),
    threshold: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    compacted: v.optional(v.boolean()),
  }),
  handler: async (ctx, args) => {
    await ctx.db.insert('documents', {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      version: args.version,
      timestamp: Date.now(),
    });

    // Auto-compact if size threshold exceeded
    const compactionResult = await _maybeCompactDocument(
      ctx,
      args.collection,
      args.documentId,
      args.threshold ?? DEFAULT_SIZE_THRESHOLD
    );

    return {
      success: true,
      compacted: compactionResult !== null,
    };
  },
});

export const stream = query({
  args: {
    collection: v.string(),
    checkpoint: v.object({
      lastModified: v.number(),
    }),
    vector: v.optional(v.bytes()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    changes: v.array(
      v.object({
        documentId: v.optional(v.string()),
        crdtBytes: v.bytes(),
        version: v.number(),
        timestamp: v.number(),
        operationType: v.string(),
      })
    ),
    checkpoint: v.object({
      lastModified: v.number(),
    }),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    // Get deltas newer than checkpoint
    const documents = await ctx.db
      .query('documents')
      .withIndex('by_timestamp', (q) =>
        q.eq('collection', args.collection).gt('timestamp', args.checkpoint.lastModified)
      )
      .order('asc')
      .take(limit);

    if (documents.length > 0) {
      const changes = documents.map((doc) => ({
        documentId: doc.documentId,
        crdtBytes: doc.crdtBytes,
        version: doc.version,
        timestamp: doc.timestamp,
        operationType: OperationType.Delta,
      }));

      const newCheckpoint = {
        lastModified: documents[documents.length - 1]?.timestamp ?? args.checkpoint.lastModified,
      };

      return {
        changes,
        checkpoint: newCheckpoint,
        hasMore: documents.length === limit,
      };
    }

    // Check for disparity - client checkpoint older than oldest delta
    const oldestDelta = await ctx.db
      .query('documents')
      .withIndex('by_timestamp', (q) => q.eq('collection', args.collection))
      .order('asc')
      .first();

    if (oldestDelta && args.checkpoint.lastModified < oldestDelta.timestamp) {
      // Disparity detected - need to send all per-document snapshots
      // Get all snapshots for this collection
      const snapshots = await ctx.db
        .query('snapshots')
        .withIndex('by_document', (q) => q.eq('collection', args.collection))
        .collect();

      if (snapshots.length === 0) {
        throw new Error(
          `Disparity detected but no snapshots available for collection: ${args.collection}. ` +
            `Client checkpoint: ${args.checkpoint.lastModified}, ` +
            `Oldest delta: ${oldestDelta.timestamp}`
        );
      }

      // Return all snapshots as changes
      const changes = snapshots.map((snapshot) => ({
        documentId: snapshot.documentId,
        crdtBytes: snapshot.snapshotBytes,
        version: 0,
        timestamp: snapshot.createdAt,
        operationType: OperationType.Snapshot,
      }));

      // Find the latest compaction timestamp to use as checkpoint
      const latestTimestamp = Math.max(...snapshots.map((s) => s.latestCompactionTimestamp));

      return {
        changes,
        checkpoint: {
          lastModified: latestTimestamp,
        },
        hasMore: false,
      };
    }

    return {
      changes: [],
      checkpoint: args.checkpoint,
      hasMore: false,
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
      checkpoint: v.object({
        lastModified: v.number(),
      }),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const logger = getLogger(['ssr']);

    // Get all per-document snapshots for this collection
    const snapshots = await ctx.db
      .query('snapshots')
      .withIndex('by_document', (q) => q.eq('collection', args.collection))
      .collect();

    // Get all deltas for this collection
    const deltas = await ctx.db
      .query('documents')
      .withIndex('by_collection', (q) => q.eq('collection', args.collection))
      .collect();

    if (snapshots.length === 0 && deltas.length === 0) {
      logger.info('No initial state available - collection is empty', {
        collection: args.collection,
      });
      return null;
    }

    // Merge all snapshots and deltas together
    const updates: Uint8Array[] = [];
    let latestTimestamp = 0;

    // Add all per-document snapshots
    for (const snapshot of snapshots) {
      updates.push(new Uint8Array(snapshot.snapshotBytes));
      latestTimestamp = Math.max(latestTimestamp, snapshot.latestCompactionTimestamp);
    }

    // Add all deltas
    const sorted = deltas.sort((a, b) => a.timestamp - b.timestamp);
    for (const delta of sorted) {
      updates.push(new Uint8Array(delta.crdtBytes));
      latestTimestamp = Math.max(latestTimestamp, delta.timestamp);
    }

    logger.info('Reconstructing initial state', {
      collection: args.collection,
      snapshotCount: snapshots.length,
      deltaCount: deltas.length,
    });

    const merged = Y.mergeUpdatesV2(updates);

    logger.info('Initial state reconstructed', {
      collection: args.collection,
      originalSize: updates.reduce((sum, u) => sum + u.byteLength, 0),
      mergedSize: merged.byteLength,
    });

    return {
      crdtBytes: merged.buffer as ArrayBuffer,
      checkpoint: {
        lastModified: latestTimestamp,
      },
    };
  },
});

/**
 * Recovery query for state vector based sync.
 * Client sends its state vector, server computes and returns the diff.
 */
export const recovery = query({
  args: {
    collection: v.string(),
    clientStateVector: v.bytes(),
  },
  returns: v.object({
    diff: v.optional(v.bytes()),
    serverStateVector: v.bytes(),
  }),
  handler: async (ctx, args) => {
    const logger = getLogger(['recovery']);

    // Get all snapshots for this collection
    const snapshots = await ctx.db
      .query('snapshots')
      .withIndex('by_document', (q) => q.eq('collection', args.collection))
      .collect();

    // Get all deltas for this collection
    const deltas = await ctx.db
      .query('documents')
      .withIndex('by_collection', (q) => q.eq('collection', args.collection))
      .collect();

    if (snapshots.length === 0 && deltas.length === 0) {
      // Empty collection - return empty state vector
      const emptyDoc = new Y.Doc();
      const emptyVector = Y.encodeStateVector(emptyDoc);
      emptyDoc.destroy();
      return { serverStateVector: emptyVector.buffer as ArrayBuffer };
    }

    // Merge all snapshots and deltas into full server state
    const updates: Uint8Array[] = [];

    for (const snapshot of snapshots) {
      updates.push(new Uint8Array(snapshot.snapshotBytes));
    }

    for (const delta of deltas) {
      updates.push(new Uint8Array(delta.crdtBytes));
    }

    const mergedState = Y.mergeUpdatesV2(updates);

    // Compute diff relative to client's state vector
    const clientVector = new Uint8Array(args.clientStateVector);
    const diff = Y.diffUpdateV2(mergedState, clientVector);
    const serverVector = Y.encodeStateVectorFromUpdateV2(mergedState);

    logger.info('Recovery sync computed', {
      collection: args.collection,
      snapshotCount: snapshots.length,
      deltaCount: deltas.length,
      diffSize: diff.byteLength,
      hasDiff: diff.byteLength > 0,
    });

    return {
      diff: diff.byteLength > 0 ? (diff.buffer as ArrayBuffer) : undefined,
      serverStateVector: serverVector.buffer as ArrayBuffer,
    };
  },
});
