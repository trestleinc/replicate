/**
 * Persistence layer types for swappable storage backends.
 *
 * Supports IndexedDB (browser), SQLite (React Native), and in-memory (testing).
 */
import type * as Y from 'yjs';

/**
 * Provider that persists Y.Doc state to storage.
 *
 * This wraps providers like y-indexeddb or y-op-sqlite, normalizing their APIs.
 */
export interface PersistenceProvider {
  /** Promise that resolves when initial sync from storage completes */
  readonly whenSynced: Promise<void>;

  /** Clean up resources (stop observing, close connections) */
  destroy(): void;
}

/**
 * Factory that creates persistence providers.
 *
 * Each persistence implementation (IndexedDB, SQLite, memory) exports a
 * factory function that returns this interface.
 */
export interface Persistence {
  /** Create a Y.Doc persistence provider for a collection */
  createDocPersistence(collection: string, ydoc: Y.Doc): PersistenceProvider;

  /** Key-value store for metadata (checkpoints, clientID) */
  readonly kv: KeyValueStore;
}

/**
 * Simple key-value storage interface.
 *
 * Used for storing metadata like checkpoints and Yjs client IDs.
 */
export interface KeyValueStore {
  /** Get a value by key */
  get<T>(key: string): Promise<T | undefined>;

  /** Set a value by key */
  set<T>(key: string, value: T): Promise<void>;

  /** Delete a value by key */
  del(key: string): Promise<void>;
}
