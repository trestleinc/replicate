/**
 * E2E tests for version history
 *
 * Tests create, list, restore, and prune version operations.
 * Uses t.run() for direct database operations.
 */
import { describe, expect, it } from 'vitest';
import { convexTest } from 'convex-test';
import * as Y from 'yjs';
import schema from '$/component/schema.js';

// Import modules for convex-test (component lives at src/component/)
// Must include _generated directory for convex-test to work
const modules = import.meta.glob('../../component/**/*.ts', { eager: true }) as Record<
  string,
  object
>;

// Helper to create a valid CRDT delta for a specific document
function createTestDelta(id: string, data: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  const ymap = doc.getMap('test');

  doc.transact(() => {
    const item = new Y.Map();
    item.set('id', id);
    for (const [key, value] of Object.entries(data)) {
      item.set(key, value);
    }
    ymap.set(id, item);
  });

  return Y.encodeStateAsUpdateV2(doc);
}

// Helper to generate unique version ID
function generateVersionId(): string {
  return `v_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

describe('version history', () => {
  it('createVersion snapshots current document state', async () => {
    const t = convexTest(schema, modules);

    // Insert a document first
    const delta = createTestDelta('doc-1', { title: 'Original' });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });
    });

    // Create a version
    const versionId = generateVersionId();
    const createdAt = Date.now();

    await t.run(async (ctx) => {
      // Get document deltas
      const deltas = await ctx.db
        .query('documents')
        .filter((q) => q.eq(q.field('documentId'), 'doc-1'))
        .collect();

      // Merge deltas
      const sorted = deltas.sort((a, b) => a.timestamp - b.timestamp);
      const updates = sorted.map((d) => new Uint8Array(d.crdtBytes));
      const merged = Y.mergeUpdatesV2(updates);

      // Store version
      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId,
        stateBytes: merged.buffer as ArrayBuffer,
        label: 'Version 1.0',
        createdAt,
        createdBy: 'user-123',
      });
    });

    // Verify the version was stored
    const versions = await t.run(async (ctx) => {
      return await ctx.db.query('versions').collect();
    });

    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe('Version 1.0');
    expect(versions[0].createdBy).toBe('user-123');
    expect(versions[0].versionId).toBe(versionId);
  });

  it('listVersions returns versions in descending order', async () => {
    const t = convexTest(schema, modules);

    // Create document
    const delta = createTestDelta('doc-1', { title: 'Test' });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });
    });

    // Create multiple versions with increasing timestamps
    await t.run(async (ctx) => {
      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId: generateVersionId(),
        stateBytes: delta.buffer as ArrayBuffer,
        label: 'First',
        createdAt: 1000,
        createdBy: undefined,
      });
      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId: generateVersionId(),
        stateBytes: delta.buffer as ArrayBuffer,
        label: 'Second',
        createdAt: 2000,
        createdBy: undefined,
      });
      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId: generateVersionId(),
        stateBytes: delta.buffer as ArrayBuffer,
        label: 'Third',
        createdAt: 3000,
        createdBy: undefined,
      });
    });

    // List versions (should be newest first)
    const versions = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_document', (q) => q.eq('collection', 'docs').eq('documentId', 'doc-1'))
        .order('desc')
        .take(50);
    });

    expect(versions).toHaveLength(3);
    // Descending order by createdAt
    expect(versions[0].label).toBe('Third');
    expect(versions[1].label).toBe('Second');
    expect(versions[2].label).toBe('First');
  });

  it('listVersions respects limit', async () => {
    const t = convexTest(schema, modules);

    // Create document and multiple versions
    const delta = createTestDelta('doc-1', { title: 'Test' });

    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });

      for (let i = 0; i < 5; i++) {
        await ctx.db.insert('versions', {
          collection: 'docs',
          documentId: 'doc-1',
          versionId: generateVersionId(),
          stateBytes: delta.buffer as ArrayBuffer,
          label: `Version ${i}`,
          createdAt: 1000 + i * 100,
          createdBy: undefined,
        });
      }
    });

    const versions = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_document', (q) => q.eq('collection', 'docs').eq('documentId', 'doc-1'))
        .order('desc')
        .take(2);
    });

    expect(versions).toHaveLength(2);
  });

  it('getVersion retrieves specific version with stateBytes', async () => {
    const t = convexTest(schema, modules);

    // Create document
    const delta = createTestDelta('doc-1', { title: 'Test' });
    const versionId = generateVersionId();

    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });

      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId,
        stateBytes: delta.buffer as ArrayBuffer,
        label: 'Test Version',
        createdAt: Date.now(),
        createdBy: undefined,
      });
    });

    // Get the version
    const version = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_version_id', (q) => q.eq('versionId', versionId))
        .first();
    });

    expect(version).not.toBeNull();
    expect(version?.versionId).toBe(versionId);
    expect(version?.collection).toBe('docs');
    expect(version?.documentId).toBe('doc-1');
    expect(version?.stateBytes).toBeDefined();
    expect(version?.label).toBe('Test Version');
  });

  it('getVersion returns null for non-existent version', async () => {
    const t = convexTest(schema, modules);

    const version = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_version_id', (q) => q.eq('versionId', 'v_nonexistent_123'))
        .first();
    });

    expect(version).toBeNull();
  });

  it('restoreVersion applies version state to document', async () => {
    const t = convexTest(schema, modules);

    // Create initial document
    const delta1 = createTestDelta('doc-1', { title: 'Original' });
    const originalVersionId = generateVersionId();

    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta1.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });

      // Create version of original state
      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId: originalVersionId,
        stateBytes: delta1.buffer as ArrayBuffer,
        label: 'Original',
        createdAt: 1000,
        createdBy: undefined,
      });
    });

    // Modify the document
    const delta2 = createTestDelta('doc-1', { title: 'Modified' });
    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta2.buffer as ArrayBuffer,
        version: 2,
        timestamp: 2000,
      });
    });

    // Restore to original version (creates new delta)
    const backupVersionId = generateVersionId();
    await t.run(async (ctx) => {
      // Get original version
      const version = await ctx.db
        .query('versions')
        .withIndex('by_version_id', (q) => q.eq('versionId', originalVersionId))
        .first();

      if (!version) throw new Error('Version not found');

      // Create backup of current state
      const currentDeltas = await ctx.db
        .query('documents')
        .filter((q) => q.eq(q.field('documentId'), 'doc-1'))
        .collect();

      const sorted = currentDeltas.sort((a, b) => a.timestamp - b.timestamp);
      const updates = sorted.map((d) => new Uint8Array(d.crdtBytes));
      const currentState = Y.mergeUpdatesV2(updates);

      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId: backupVersionId,
        stateBytes: currentState.buffer as ArrayBuffer,
        label: `Backup before restore to ${originalVersionId}`,
        createdAt: Date.now(),
        createdBy: undefined,
      });

      // Insert version's stateBytes as new delta
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: version.stateBytes,
        version: Date.now(),
        timestamp: Date.now(),
      });
    });

    // Should have created a new delta for the restore
    const docs = await t.run(async (ctx) => {
      return await ctx.db
        .query('documents')
        .filter((q) => q.eq(q.field('documentId'), 'doc-1'))
        .collect();
    });

    // Original + Modified + Restore = 3 deltas
    expect(docs.length).toBe(3);

    // Should have backup version
    const backup = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_version_id', (q) => q.eq('versionId', backupVersionId))
        .first();
    });
    expect(backup).not.toBeNull();
  });

  it('deleteVersion removes version', async () => {
    const t = convexTest(schema, modules);

    const delta = createTestDelta('doc-1', { title: 'Test' });
    const versionId = generateVersionId();

    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });

      await ctx.db.insert('versions', {
        collection: 'docs',
        documentId: 'doc-1',
        versionId,
        stateBytes: delta.buffer as ArrayBuffer,
        label: 'To delete',
        createdAt: Date.now(),
        createdBy: undefined,
      });
    });

    // Delete the version
    await t.run(async (ctx) => {
      const version = await ctx.db
        .query('versions')
        .withIndex('by_version_id', (q) => q.eq('versionId', versionId))
        .first();

      if (version) {
        await ctx.db.delete('versions', version._id);
      }
    });

    // Verify it's gone
    const fetched = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_version_id', (q) => q.eq('versionId', versionId))
        .first();
    });

    expect(fetched).toBeNull();
  });

  it('pruneVersions keeps only keepCount most recent', async () => {
    const t = convexTest(schema, modules);

    // Create document with many versions
    const delta = createTestDelta('doc-1', { title: 'Test' });

    await t.run(async (ctx) => {
      await ctx.db.insert('documents', {
        collection: 'docs',
        documentId: 'doc-1',
        crdtBytes: delta.buffer as ArrayBuffer,
        version: 1,
        timestamp: 1000,
      });

      // Create 5 versions with old timestamps
      const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert('versions', {
          collection: 'docs',
          documentId: 'doc-1',
          versionId: generateVersionId(),
          stateBytes: delta.buffer as ArrayBuffer,
          label: `Version ${i}`,
          createdAt: oldTimestamp + i * 1000,
          createdBy: undefined,
        });
      }
    });

    // Verify we have 5 versions
    const before = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_document', (q) => q.eq('collection', 'docs').eq('documentId', 'doc-1'))
        .collect();
    });
    expect(before).toHaveLength(5);

    // Prune to keep only 2
    const keepCount = 2;
    const cutoffTime = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 days

    await t.run(async (ctx) => {
      const versions = await ctx.db
        .query('versions')
        .withIndex('by_document', (q) => q.eq('collection', 'docs').eq('documentId', 'doc-1'))
        .order('desc')
        .collect();

      // Delete old versions beyond keepCount
      for (let i = keepCount; i < versions.length; i++) {
        const version = versions[i];
        if (version.createdAt < cutoffTime) {
          await ctx.db.delete('versions', version._id);
        }
      }
    });

    // Verify only 2 remain
    const after = await t.run(async (ctx) => {
      return await ctx.db
        .query('versions')
        .withIndex('by_document', (q) => q.eq('collection', 'docs').eq('documentId', 'doc-1'))
        .collect();
    });
    expect(after).toHaveLength(2);
  });
});
