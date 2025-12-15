/**
 * Integration tests for recovery scenarios
 *
 * Tests snapshot recovery and phantom document cleanup.
 * IndexedDB persistence is tested by y-indexeddb library itself.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestDoc, applyUpdate } from '../utils/yjs.js';
import { createTestCollection } from '../utils/collection.js';

interface Task {
  id: string;
  title: string;
  completed: boolean;
}

describe('recovery', () => {
  describe('snapshot recovery', () => {
    it('applies snapshot to clear and restore state', () => {
      // Simulate a client with stale local state
      const staleClient = createTestCollection<Task>('tasks', 1);
      staleClient.insert({ id: 'old-task', title: 'Old task', completed: false });

      // Create a "server snapshot" from another source
      const serverDoc = createTestDoc(999);
      const serverYmap = serverDoc.getMap('tasks');
      serverDoc.transact(() => {
        const item1 = new Y.Map();
        item1.set('id', 'new-task-1');
        item1.set('title', 'New task 1');
        item1.set('completed', false);
        serverYmap.set('new-task-1', item1);

        const item2 = new Y.Map();
        item2.set('id', 'new-task-2');
        item2.set('title', 'New task 2');
        item2.set('completed', true);
        serverYmap.set('new-task-2', item2);
      });
      const snapshot = Y.encodeStateAsUpdateV2(serverDoc);

      // Clear stale client and apply snapshot
      staleClient.doc.transact(() => {
        const keys = Array.from(staleClient.ymap.keys());
        for (const key of keys) {
          staleClient.ymap.delete(key);
        }
      });

      // Apply snapshot
      applyUpdate(staleClient.doc, snapshot);

      // Client should now have server state
      const tasks = staleClient.getAll();
      expect(tasks).toHaveLength(2);
      expect(tasks.find((t) => t.id === 'new-task-1')).toBeDefined();
      expect(tasks.find((t) => t.id === 'new-task-2')).toBeDefined();
      expect(tasks.find((t) => t.id === 'old-task')).toBeUndefined();
    });

    it('handles empty snapshot gracefully', () => {
      const client = createTestCollection<Task>('tasks', 1);
      client.insert({ id: 'task-1', title: 'Existing', completed: false });

      // Empty server state
      const emptyServerDoc = createTestDoc(999);
      emptyServerDoc.getMap('tasks'); // Initialize map but don't add items
      const emptySnapshot = Y.encodeStateAsUpdateV2(emptyServerDoc);

      // Clear and apply empty snapshot
      client.doc.transact(() => {
        const keys = Array.from(client.ymap.keys());
        for (const key of keys) {
          client.ymap.delete(key);
        }
      });
      applyUpdate(client.doc, emptySnapshot);

      expect(client.getAll()).toHaveLength(0);
    });
  });

  describe('phantom document reconciliation', () => {
    it('removes documents that exist locally but not on server', () => {
      const localClient = createTestCollection<Task>('tasks', 1);

      // Local has some tasks
      localClient.insert({ id: 'local-only', title: 'Local only', completed: false });
      localClient.insert({ id: 'shared', title: 'Shared', completed: false });
      localClient.insert({ id: 'also-local', title: 'Also local', completed: true });

      // Server only has 'shared'
      const serverDocs = [{ id: 'shared' }];
      const serverIds = new Set(serverDocs.map((d) => d.id));

      // Find phantom documents
      const localIds = localClient.getAll().map((t) => t.id);
      const phantomIds = localIds.filter((id) => !serverIds.has(id));

      expect(phantomIds).toContain('local-only');
      expect(phantomIds).toContain('also-local');
      expect(phantomIds).not.toContain('shared');

      // Remove phantoms
      for (const id of phantomIds) {
        localClient.delete(id);
      }

      // Verify only shared remains
      expect(localClient.getAll()).toHaveLength(1);
      expect(localClient.get('shared')).not.toBeNull();
    });

    it('handles case where all local documents are phantoms', () => {
      const localClient = createTestCollection<Task>('tasks', 1);

      localClient.insert({ id: 'phantom-1', title: 'Phantom 1', completed: false });
      localClient.insert({ id: 'phantom-2', title: 'Phantom 2', completed: false });

      // Server has nothing
      const serverIds = new Set<string>();

      // Remove all as phantoms
      const localIds = localClient.getAll().map((t) => t.id);
      for (const id of localIds.filter((id) => !serverIds.has(id))) {
        localClient.delete(id);
      }

      expect(localClient.getAll()).toHaveLength(0);
    });

    it('handles case where server has extra documents', () => {
      const localClient = createTestCollection<Task>('tasks', 1);

      localClient.insert({ id: 'existing', title: 'Existing', completed: false });

      // Server has more than local
      const serverIds = new Set(['existing', 'new-from-server']);

      // No phantoms (local is subset of server)
      const localIds = localClient.getAll().map((t) => t.id);
      const phantomIds = localIds.filter((id) => !serverIds.has(id));

      expect(phantomIds).toHaveLength(0);
    });
  });
});
