/**
 * IndexedDB persistence implementation for browser environments.
 *
 * Uses y-indexeddb for Y.Doc persistence and browser-level for key-value storage.
 * browser-level is an abstract-level database backed by IndexedDB.
 */
import type * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { BrowserLevel } from 'browser-level';
import type { Persistence, PersistenceProvider, KeyValueStore } from './types.js';

/**
 * browser-level backed key-value store.
 *
 * Uses the Level ecosystem for consistent API across browser and React Native.
 */
class BrowserLevelKeyValueStore implements KeyValueStore {
  private db: BrowserLevel<string, string>;

  constructor(dbName: string) {
    this.db = new BrowserLevel(dbName);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.db.get(key);
      if (value === undefined) {
        return undefined;
      }
      return JSON.parse(value) as T;
    } catch (err: any) {
      // Level throws LEVEL_NOT_FOUND error for missing keys
      if (err.code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw err;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.db.put(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    try {
      await this.db.del(key);
    } catch (err: any) {
      // Ignore not found errors on delete
      if (err.code !== 'LEVEL_NOT_FOUND') {
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * IndexedDB persistence provider wrapping y-indexeddb.
 */
class IndexedDBPersistenceProvider implements PersistenceProvider {
  private persistence: IndexeddbPersistence;
  readonly whenSynced: Promise<void>;

  constructor(collection: string, ydoc: Y.Doc) {
    this.persistence = new IndexeddbPersistence(collection, ydoc);
    // Normalize y-indexeddb's event-based API to a Promise
    this.whenSynced = new Promise((resolve) => {
      this.persistence.on('synced', () => resolve());
    });
  }

  destroy(): void {
    this.persistence.destroy();
  }
}

/**
 * Create an IndexedDB persistence factory.
 *
 * Uses y-indexeddb for Y.Doc persistence and browser-level for metadata storage.
 *
 * @param dbName - Name for the LevelDB database (default: 'replicate-kv')
 *
 * @example
 * ```typescript
 * convexCollectionOptions<Task>({
 *   // ... other options
 *   persistence: indexeddbPersistence(),
 * });
 * ```
 */
export function indexeddbPersistence(dbName = 'replicate-kv'): Persistence {
  const kv = new BrowserLevelKeyValueStore(dbName);
  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new IndexedDBPersistenceProvider(collection, ydoc),
    kv,
  };
}
