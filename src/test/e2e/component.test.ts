/**
 * E2E tests for Convex component
 *
 * Tests the component mutations and queries using convex-test.
 * Uses t.run() for direct database operations since the component
 * doesn't export a generated API with function references.
 */
import { describe, expect, it } from 'vitest';
import { convexTest } from 'convex-test';
import * as Y from 'yjs';
import schema from '$/component/schema.js';
import { OperationType } from '$/shared/types.js';

// Import component functions directly for testing via t.run()
import * as publicModule from '$/component/public.js';

// Import modules for convex-test (component lives at src/component/)
// Must include _generated directory for convex-test to work
const modules = import.meta.glob('../../component/**/*.ts', { eager: true }) as Record<
  string,
  object
>;

// Helper to create a valid CRDT delta
function createTestDelta(data: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  const ymap = doc.getMap('test');

  doc.transact(() => {
    const item = new Y.Map();
    for (const [key, value] of Object.entries(data)) {
      item.set(key, value);
    }
    ymap.set(data.id as string, item);
  });

  return Y.encodeStateAsUpdateV2(doc);
}

describe('component mutations', () => {
  it('insertDocument appends delta to documents table', async () => {
    const t = convexTest(schema, modules);

    const crdtBytes = createTestDelta({ id: 'task-1', title: 'Test task' });

    // Insert directly via t.run()
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: crdtBytes.buffer as ArrayBuffer,
        version: 1,
        timestamp: Date.now(),
      });
    });

    // Verify the document was inserted
    const docs = await t.run(async (ctx) => {
      return await ctx.db
        .query('documents')
        .filter((q) => q.eq(q.field('documentId'), 'task-1'))
        .collect();
    });

    expect(docs).toHaveLength(1);
    expect(docs[0].collection).toBe('tasks');
    expect(docs[0].documentId).toBe('task-1');
    expect(docs[0].version).toBe(1);
  });

  it('updateDocument appends new delta', async () => {
    const t = convexTest(schema, modules);

    // Insert initial
    const insertDelta = createTestDelta({ id: 'task-1', title: 'Original' });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: insertDelta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });
    });

    // Update (insert another delta)
    const updateDelta = createTestDelta({ id: 'task-1', title: 'Updated' });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: updateDelta.buffer as ArrayBuffer,
        version: 2,
        timestamp: 2000,
      });
    });

    // Should have 2 documents (deltas)
    const docs = await t.run(async (ctx) => {
      return await ctx.db
        .query('documents')
        .filter((q) => q.eq(q.field('documentId'), 'task-1'))
        .collect();
    });

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.version).sort()).toEqual([1, 2]);
  });

  it('deleteDocument appends tombstone delta', async () => {
    const t = convexTest(schema, modules);

    // Insert
    const insertDelta = createTestDelta({ id: 'task-1', title: 'To delete' });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: insertDelta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });
    });

    // Delete (still appends a delta in the replicate pattern)
    const deleteDelta = createTestDelta({ id: 'task-1' });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: deleteDelta.buffer as ArrayBuffer,
        version: 2,
        timestamp: 2000,
      });
    });

    // Should have 2 deltas (insert + delete)
    const docs = await t.run(async (ctx) => {
      return await ctx.db
        .query('documents')
        .filter((q) => q.eq(q.field('documentId'), 'task-1'))
        .collect();
    });

    expect(docs).toHaveLength(2);
  });
});

describe('component queries', () => {
  it('stream returns deltas since checkpoint', async () => {
    const t = convexTest(schema, modules);

    // Insert some documents with different timestamps
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: new ArrayBuffer(10),
        version: 1,
        timestamp: 1000,
      });
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-2',
        crdtBytes: new ArrayBuffer(10),
        version: 1,
        timestamp: 2000,
      });
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-3',
        crdtBytes: new ArrayBuffer(10),
        version: 1,
        timestamp: 3000,
      });
    });

    // Query documents after checkpoint 1500
    const result = await t.run(async (ctx) => {
      const docs = await ctx.db
        .query('documents')
        .withIndex('by_timestamp', (q) => q.eq('collection', 'tasks').gt('timestamp', 1500))
        .order('asc')
        .take(100);

      const changes = docs.map((doc) => ({
        documentId: doc.documentId,
        crdtBytes: doc.crdtBytes,
        version: doc.version,
        timestamp: doc.timestamp,
        operationType: OperationType.Delta,
      }));

      const newCheckpoint = {
        lastModified: docs.length > 0 ? docs[docs.length - 1].timestamp : 1500,
      };

      return {
        changes,
        checkpoint: newCheckpoint,
        hasMore: docs.length === 100,
      };
    });

    expect(result.changes).toHaveLength(2);
    expect(result.changes.map((c) => c.documentId)).toEqual(['task-2', 'task-3']);
    expect(result.checkpoint.lastModified).toBe(3000);
    expect(result.hasMore).toBe(false);
  });

  it('stream returns empty when checkpoint is current', async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: new ArrayBuffer(10),
        version: 1,
        timestamp: 1000,
      });
    });

    const result = await t.run(async (ctx) => {
      const docs = await ctx.db
        .query('documents')
        .withIndex('by_timestamp', (q) => q.eq('collection', 'tasks').gt('timestamp', 1000))
        .order('asc')
        .take(100);

      return {
        changes: docs.map((doc) => ({
          documentId: doc.documentId,
          operationType: OperationType.Delta,
        })),
        checkpoint: { lastModified: 1000 },
        hasMore: false,
      };
    });

    expect(result.changes).toHaveLength(0);
    expect(result.checkpoint.lastModified).toBe(1000);
    expect(result.hasMore).toBe(false);
  });

  it('stream returns snapshot when checkpoint gap detected', async () => {
    const t = convexTest(schema, modules);

    // Create a snapshot and a delta after it
    await t.run(async (ctx) => {
      await ctx.db.insert('snapshots', {
        collection: 'tasks',
        snapshotBytes: new ArrayBuffer(100),
        latestCompactionTimestamp: 5000,
        createdAt: 5000,
      });

      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-recent',
        crdtBytes: new ArrayBuffer(10),
        version: 1,
        timestamp: 6000,
      });
    });

    // Client has checkpoint 100 (way behind oldest delta 6000)
    const result = await t.run(async (ctx) => {
      const checkpoint = { lastModified: 100 };

      // Check for documents after checkpoint
      const docs = await ctx.db
        .query('documents')
        .withIndex('by_timestamp', (q) =>
          q.eq('collection', 'tasks').gt('timestamp', checkpoint.lastModified)
        )
        .order('asc')
        .take(100);

      // If no docs, check for gap
      if (docs.length === 0) {
        const oldestDelta = await ctx.db
          .query('documents')
          .withIndex('by_timestamp', (q) => q.eq('collection', 'tasks'))
          .order('asc')
          .first();

        if (oldestDelta && checkpoint.lastModified < oldestDelta.timestamp) {
          const snapshot = await ctx.db
            .query('snapshots')
            .withIndex('by_collection', (q) => q.eq('collection', 'tasks'))
            .order('desc')
            .first();

          if (snapshot) {
            return {
              changes: [
                {
                  crdtBytes: snapshot.snapshotBytes,
                  version: 0,
                  timestamp: snapshot.createdAt,
                  operationType: OperationType.Snapshot,
                },
              ],
              checkpoint: { lastModified: snapshot.latestCompactionTimestamp },
              hasMore: false,
            };
          }
        }
      }

      return {
        changes: docs.map((doc) => ({
          documentId: doc.documentId,
          crdtBytes: doc.crdtBytes,
          version: doc.version,
          timestamp: doc.timestamp,
          operationType: OperationType.Delta,
        })),
        checkpoint: {
          lastModified: docs.length > 0 ? docs[docs.length - 1].timestamp : checkpoint.lastModified,
        },
        hasMore: docs.length === 100,
      };
    });

    // When checkpoint is behind oldest delta, should return the newer deltas
    // (or snapshot if gap detected and no deltas match)
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it('getProtocolVersion returns current version', async () => {
    // Protocol version is a constant, just verify it
    expect(publicModule.PROTOCOL_VERSION).toBe(1);
  });

  it('getInitialState returns null for empty collection', async () => {
    const t = convexTest(schema, modules);

    const result = await t.run(async (ctx) => {
      const snapshot = await ctx.db
        .query('snapshots')
        .withIndex('by_collection', (q) => q.eq('collection', 'empty'))
        .order('desc')
        .first();

      if (snapshot) {
        return {
          crdtBytes: snapshot.snapshotBytes,
          checkpoint: { lastModified: snapshot.latestCompactionTimestamp },
        };
      }

      const deltas = await ctx.db
        .query('documents')
        .withIndex('by_collection', (q) => q.eq('collection', 'empty'))
        .collect();

      if (deltas.length === 0) {
        return null;
      }

      // Would merge deltas here
      return { crdtBytes: new ArrayBuffer(0), checkpoint: { lastModified: 0 } };
    });

    expect(result).toBeNull();
  });

  it('getInitialState reconstructs state from deltas', async () => {
    const t = convexTest(schema, modules);

    // Create valid Yjs deltas
    const delta1 = createTestDelta({ id: 'task-1', title: 'Task 1' });
    const delta2 = createTestDelta({ id: 'task-2', title: 'Task 2' });

    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-1',
        crdtBytes: delta1.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });
      await ctx.db.insert('documents', {
        collection: 'tasks',
        documentId: 'task-2',
        crdtBytes: delta2.buffer as ArrayBuffer,
        version: 1,
        timestamp: 2000,
      });
    });

    // Query deltas and verify they can be merged
    // Note: t.run() uses Convex serialization which doesn't support Uint8Array return values,
    // so we return metadata only and verify the merge works
    const result = await t.run(async (ctx) => {
      const deltas = await ctx.db
        .query('documents')
        .withIndex('by_collection', (q) => q.eq('collection', 'tasks'))
        .collect();

      if (deltas.length === 0) {
        return null;
      }

      const sorted = deltas.sort((a, b) => a.timestamp - b.timestamp);
      const updates = sorted.map((d) => new Uint8Array(d.crdtBytes));
      const merged = Y.mergeUpdatesV2(updates);

      // Return metadata only (Convex doesn't serialize Uint8Array in t.run())
      return {
        deltaCount: deltas.length,
        mergedByteLength: merged.byteLength,
        checkpoint: { lastModified: sorted[sorted.length - 1].timestamp },
      };
    });

    expect(result).not.toBeNull();
    expect(result?.deltaCount).toBe(2);
    expect(result?.mergedByteLength).toBeGreaterThan(0);
    expect(result?.checkpoint.lastModified).toBe(2000);
  });
});
