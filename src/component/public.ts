import * as Y from 'yjs';
import { v } from 'convex/values';
import { mutation, query } from '$/component/_generated/server';
import { getLogger } from '$/component/logger';
import { OperationType } from '$/shared/types.js';

export const PROTOCOL_VERSION = 1;

export { OperationType };

export const insertDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
    version: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await ctx.db.insert('documents', {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      version: args.version,
      timestamp: Date.now(),
    });

    return { success: true };
  },
});

export const updateDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
    version: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await ctx.db.insert('documents', {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      version: args.version,
      timestamp: Date.now(),
    });

    return { success: true };
  },
});

export const deleteDocument = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
    version: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await ctx.db.insert('documents', {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: args.crdtBytes,
      version: args.version,
      timestamp: Date.now(),
    });

    return { success: true };
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

    const oldestDelta = await ctx.db
      .query('documents')
      .withIndex('by_timestamp', (q) => q.eq('collection', args.collection))
      .order('asc')
      .first();

    if (oldestDelta && args.checkpoint.lastModified < oldestDelta.timestamp) {
      const snapshot = await ctx.db
        .query('snapshots')
        .withIndex('by_collection', (q) => q.eq('collection', args.collection))
        .order('desc')
        .first();

      if (!snapshot) {
        throw new Error(
          `Disparity detected but no snapshot available for collection: ${args.collection}. ` +
            `Client checkpoint: ${args.checkpoint.lastModified}, ` +
            `Oldest delta: ${oldestDelta.timestamp}`
        );
      }

      return {
        changes: [
          {
            crdtBytes: snapshot.snapshotBytes,
            version: 0,
            timestamp: snapshot.createdAt,
            operationType: OperationType.Snapshot,
          },
        ],
        checkpoint: {
          lastModified: snapshot.latestCompactionTimestamp,
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

export const getProtocolVersion = query({
  args: {},
  returns: v.object({
    protocolVersion: v.number(),
  }),
  handler: async (_ctx) => {
    return {
      protocolVersion: PROTOCOL_VERSION,
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

    const snapshot = await ctx.db
      .query('snapshots')
      .withIndex('by_collection', (q) => q.eq('collection', args.collection))
      .order('desc')
      .first();

    if (snapshot) {
      // Note: Despite the table name "snapshots", snapshotBytes contains a merged Yjs UPDATE
      // (created via Y.mergeUpdatesV2), not a Yjs snapshot (Y.encodeSnapshotV2).
      // This can be applied directly with Y.applyUpdateV2() on the client.
      logger.info('Serving initial state from compacted snapshot', {
        collection: args.collection,
        snapshotSize: snapshot.snapshotBytes.byteLength,
        checkpoint: snapshot.latestCompactionTimestamp,
      });

      return {
        crdtBytes: snapshot.snapshotBytes,
        checkpoint: {
          lastModified: snapshot.latestCompactionTimestamp,
        },
      };
    }

    const deltas = await ctx.db
      .query('documents')
      .withIndex('by_collection', (q) => q.eq('collection', args.collection))
      .collect();

    if (deltas.length === 0) {
      logger.info('No initial state available - collection is empty', {
        collection: args.collection,
      });
      return null;
    }

    logger.info('Reconstructing initial state from deltas', {
      collection: args.collection,
      deltaCount: deltas.length,
    });

    const sorted = deltas.sort((a, b) => a.timestamp - b.timestamp);

    const updates = sorted.map((d) => new Uint8Array(d.crdtBytes));
    const merged = Y.mergeUpdatesV2(updates);

    logger.info('Initial state reconstructed', {
      collection: args.collection,
      originalSize: updates.reduce((sum, u) => sum + u.byteLength, 0),
      mergedSize: merged.byteLength,
      compressionRatio: (
        updates.reduce((sum, u) => sum + u.byteLength, 0) / merged.byteLength
      ).toFixed(2),
    });

    return {
      crdtBytes: merged.buffer as ArrayBuffer,
      checkpoint: {
        lastModified: sorted[sorted.length - 1].timestamp,
      },
    };
  },
});

async function _compactCollectionInternal(ctx: any, collection: string, retentionDays?: number) {
  const cutoffMs = (retentionDays ?? 90) * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - cutoffMs;

  const logger = getLogger(['compaction']);

  logger.info('Starting compaction', {
    collection,
    retentionDays: retentionDays ?? 90,
    cutoffTime,
  });

  const oldDeltas = await ctx.db
    .query('documents')
    .withIndex('by_timestamp', (q: any) =>
      q.eq('collection', collection).lt('timestamp', cutoffTime)
    )
    .collect();

  if (oldDeltas.length < 100) {
    logger.info('Skipping compaction - insufficient deltas', {
      collection,
      deltaCount: oldDeltas.length,
    });
    return {
      skipped: true,
      reason: 'insufficient deltas',
      deltaCount: oldDeltas.length,
    };
  }

  const sorted = oldDeltas.sort((a: any, b: any) => a.timestamp - b.timestamp);

  logger.info('Compacting deltas', {
    collection,
    deltaCount: sorted.length,
    oldestTimestamp: sorted[0].timestamp,
    newestTimestamp: sorted[sorted.length - 1].timestamp,
  });

  const updates = sorted.map((d: any) => new Uint8Array(d.crdtBytes));

  // Merge all deltas into a single compacted state
  // NOTE: We store the merged UPDATE, not a Yjs snapshot.
  // Y.snapshot() creates a "delete set" for version comparison, not document state.
  // Y.mergeUpdatesV2() creates actual document state that can be applied with applyUpdateV2().
  const compactedState = Y.mergeUpdatesV2(updates);

  logger.info('Created compacted state', {
    collection,
    compactedSize: compactedState.length,
    compressionRatio: (
      sorted.reduce((sum: any, d: any) => sum + d.crdtBytes.byteLength, 0) / compactedState.length
    ).toFixed(2),
  });

  // Validate: verify compacted state can be applied to a fresh document
  const testDoc = new Y.Doc({ guid: collection });
  try {
    Y.applyUpdateV2(testDoc, compactedState);
  } catch (error) {
    logger.error('Compacted state validation failed - cannot apply to document', {
      collection,
      error: String(error),
    });
    testDoc.destroy();
    return {
      success: false,
      error: 'validation_failed',
    };
  }
  testDoc.destroy();

  await ctx.db.insert('snapshots', {
    collection,
    snapshotBytes: compactedState.buffer as ArrayBuffer,
    latestCompactionTimestamp: sorted[sorted.length - 1].timestamp,
    createdAt: Date.now(),
  });

  for (const delta of sorted) {
    await ctx.db.delete('documents', delta._id);
  }

  const result = {
    success: true,
    deltasCompacted: sorted.length,
    snapshotSize: compactedState.length,
    oldestDelta: sorted[0].timestamp,
    newestDelta: sorted[sorted.length - 1].timestamp,
  };

  logger.info('Compaction completed', result);

  return result;
}

export const compactCollectionByName = mutation({
  args: {
    collection: v.string(),
    retentionDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await _compactCollectionInternal(ctx, args.collection, args.retentionDays);
  },
});

export const pruneCollectionByName = mutation({
  args: {
    collection: v.string(),
    retentionDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const retentionMs = (args.retentionDays ?? 180) * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;

    const logger = getLogger(['compaction']);

    logger.info('Starting snapshot cleanup for collection', {
      collection: args.collection,
      retentionDays: args.retentionDays ?? 180,
      cutoffTime,
    });

    const snapshots = await ctx.db
      .query('snapshots')
      .withIndex('by_collection', (q) => q.eq('collection', args.collection))
      .order('desc')
      .collect();

    logger.debug('Processing collection snapshots', {
      collection: args.collection,
      snapshotCount: snapshots.length,
    });

    let deletedCount = 0;

    for (let i = 2; i < snapshots.length; i++) {
      const snapshot = snapshots[i];

      if (snapshot.createdAt < cutoffTime) {
        await ctx.db.delete('snapshots', snapshot._id);
        deletedCount++;
        logger.debug('Deleted old snapshot', {
          collection: args.collection,
          snapshotAge: Date.now() - snapshot.createdAt,
          createdAt: snapshot.createdAt,
        });
      }
    }

    const result = {
      collection: args.collection,
      deletedCount,
      snapshotsRemaining: Math.min(2, snapshots.length),
    };

    logger.info('Snapshot cleanup completed for collection', result);

    return result;
  },
});

// ============================================================================
// Version History APIs
// ============================================================================

/**
 * Reconstructs a document's current state from all deltas.
 * Returns the merged state bytes that can be applied to a fresh Y.Doc.
 */
async function _reconstructDocumentState(
  ctx: any,
  collection: string,
  documentId: string
): Promise<{ stateBytes: Uint8Array; latestTimestamp: number } | null> {
  // First check for a compacted snapshot
  const snapshot = await ctx.db
    .query('snapshots')
    .withIndex('by_collection', (q: any) => q.eq('collection', collection))
    .order('desc')
    .first();

  // Get all deltas for this specific document
  const deltas = await ctx.db
    .query('documents')
    .withIndex('by_collection_document_version', (q: any) =>
      q.eq('collection', collection).eq('documentId', documentId)
    )
    .collect();

  if (deltas.length === 0 && !snapshot) {
    return null;
  }

  const updates: Uint8Array[] = [];
  let latestTimestamp = 0;

  // Start with snapshot if available and relevant
  if (snapshot) {
    updates.push(new Uint8Array(snapshot.snapshotBytes));
    latestTimestamp = snapshot.latestCompactionTimestamp;
  }

  // Add all deltas for this document
  const sorted = deltas.sort((a: any, b: any) => a.timestamp - b.timestamp);
  for (const delta of sorted) {
    updates.push(new Uint8Array(delta.crdtBytes));
    latestTimestamp = Math.max(latestTimestamp, delta.timestamp);
  }

  if (updates.length === 0) {
    return null;
  }

  const merged = Y.mergeUpdatesV2(updates);
  return { stateBytes: merged, latestTimestamp };
}

export const createVersion = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    label: v.optional(v.string()),
    createdBy: v.optional(v.string()),
  },
  returns: v.object({
    versionId: v.string(),
    createdAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const logger = getLogger(['versions']);

    logger.info('Creating version', {
      collection: args.collection,
      documentId: args.documentId,
      label: args.label,
    });

    const result = await _reconstructDocumentState(ctx, args.collection, args.documentId);

    if (!result) {
      throw new Error(`Document not found: ${args.documentId} in collection ${args.collection}`);
    }

    // Generate a unique version ID
    const versionId = `v_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const createdAt = Date.now();

    await ctx.db.insert('versions', {
      collection: args.collection,
      documentId: args.documentId,
      versionId,
      stateBytes: result.stateBytes.buffer as ArrayBuffer,
      label: args.label,
      createdAt,
      createdBy: args.createdBy,
    });

    logger.info('Version created', {
      collection: args.collection,
      documentId: args.documentId,
      versionId,
      stateSize: result.stateBytes.byteLength,
    });

    return { versionId, createdAt };
  },
});

export const listVersions = query({
  args: {
    collection: v.string(),
    documentId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      versionId: v.string(),
      label: v.union(v.string(), v.null()),
      createdAt: v.number(),
      createdBy: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    const versions = await ctx.db
      .query('versions')
      .withIndex('by_document', (q) =>
        q.eq('collection', args.collection).eq('documentId', args.documentId)
      )
      .order('desc')
      .take(limit);

    return versions.map((v) => ({
      versionId: v.versionId,
      label: v.label ?? null,
      createdAt: v.createdAt,
      createdBy: v.createdBy ?? null,
    }));
  },
});

export const getVersion = query({
  args: {
    versionId: v.string(),
  },
  returns: v.union(
    v.object({
      versionId: v.string(),
      collection: v.string(),
      documentId: v.string(),
      stateBytes: v.bytes(),
      label: v.union(v.string(), v.null()),
      createdAt: v.number(),
      createdBy: v.union(v.string(), v.null()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const version = await ctx.db
      .query('versions')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .first();

    if (!version) {
      return null;
    }

    return {
      versionId: version.versionId,
      collection: version.collection,
      documentId: version.documentId,
      stateBytes: version.stateBytes,
      label: version.label ?? null,
      createdAt: version.createdAt,
      createdBy: version.createdBy ?? null,
    };
  },
});

export const restoreVersion = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    versionId: v.string(),
    createBackup: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
    backupVersionId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const logger = getLogger(['versions']);

    logger.info('Restoring version', {
      collection: args.collection,
      documentId: args.documentId,
      versionId: args.versionId,
      createBackup: args.createBackup,
    });

    // Get the version to restore
    const version = await ctx.db
      .query('versions')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .first();

    if (!version) {
      throw new Error(`Version not found: ${args.versionId}`);
    }

    if (version.collection !== args.collection || version.documentId !== args.documentId) {
      throw new Error(
        `Version ${args.versionId} does not belong to document ${args.documentId} in collection ${args.collection}`
      );
    }

    let backupVersionId: string | null = null;

    // Optionally create a backup of current state before restore
    if (args.createBackup !== false) {
      const currentState = await _reconstructDocumentState(ctx, args.collection, args.documentId);

      if (currentState) {
        backupVersionId = `v_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        await ctx.db.insert('versions', {
          collection: args.collection,
          documentId: args.documentId,
          versionId: backupVersionId,
          stateBytes: currentState.stateBytes.buffer as ArrayBuffer,
          label: `Backup before restore to ${args.versionId}`,
          createdAt: Date.now(),
          createdBy: undefined,
        });

        logger.info('Created backup version', {
          backupVersionId,
          collection: args.collection,
          documentId: args.documentId,
        });
      }
    }

    // To restore, we need to create a delta that brings the document to the version's state.
    // We insert the version's stateBytes as a new delta - Yjs will merge it correctly.
    await ctx.db.insert('documents', {
      collection: args.collection,
      documentId: args.documentId,
      crdtBytes: version.stateBytes,
      version: Date.now(), // Use timestamp as version to ensure uniqueness
      timestamp: Date.now(),
    });

    logger.info('Version restored', {
      collection: args.collection,
      documentId: args.documentId,
      versionId: args.versionId,
      backupVersionId,
    });

    return { success: true, backupVersionId };
  },
});

export const deleteVersion = mutation({
  args: {
    versionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const logger = getLogger(['versions']);

    const version = await ctx.db
      .query('versions')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .first();

    if (!version) {
      throw new Error(`Version not found: ${args.versionId}`);
    }

    await ctx.db.delete('versions', version._id);

    logger.info('Version deleted', {
      versionId: args.versionId,
      collection: version.collection,
      documentId: version.documentId,
    });

    return { success: true };
  },
});

export const pruneVersions = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    keepCount: v.optional(v.number()),
    retentionDays: v.optional(v.number()),
  },
  returns: v.object({
    deletedCount: v.number(),
    remainingCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const logger = getLogger(['versions']);
    const keepCount = args.keepCount ?? 10;
    const retentionMs = (args.retentionDays ?? 90) * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;

    const versions = await ctx.db
      .query('versions')
      .withIndex('by_document', (q) =>
        q.eq('collection', args.collection).eq('documentId', args.documentId)
      )
      .order('desc')
      .collect();

    let deletedCount = 0;

    // Keep the most recent `keepCount` versions, delete older ones past retention
    for (let i = keepCount; i < versions.length; i++) {
      const version = versions[i];
      if (version.createdAt < cutoffTime) {
        await ctx.db.delete('versions', version._id);
        deletedCount++;
      }
    }

    logger.info('Pruned versions', {
      collection: args.collection,
      documentId: args.documentId,
      deletedCount,
      remainingCount: versions.length - deletedCount,
    });

    return {
      deletedCount,
      remainingCount: versions.length - deletedCount,
    };
  },
});
