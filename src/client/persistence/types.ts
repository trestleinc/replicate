/**
 * Persistence layer types for swappable storage backends.
 *
 * Architecture:
 * - StorageAdapter: Low-level binary key-value interface (implement this for custom backends)
 * - Persistence: High-level interface used by collections (created from StorageAdapter)
 *
 * For custom storage backends (Chrome extension storage, localStorage, etc.),
 * implement StorageAdapter and use createPersistence() to wrap it.
 */
import type * as Y from "yjs";

/**
 * Low-level storage adapter interface.
 *
 * Implement this for custom storage backends like:
 * - Chrome extension storage API
 * - localStorage/sessionStorage
 * - Cloud storage (Firebase, Supabase)
 * - Custom file-based storage
 *
 * The adapter handles raw binary data. The replicate library handles
 * all Yjs serialization/deserialization internally.
 *
 * @example Chrome extension storage
 * ```typescript
 * class ChromeStorageAdapter implements StorageAdapter {
 *   async get(key: string): Promise<Uint8Array | undefined> {
 *     const result = await chrome.storage.local.get(key);
 *     return result[key] ? new Uint8Array(result[key]) : undefined;
 *   }
 *
 *   async set(key: string, value: Uint8Array): Promise<void> {
 *     await chrome.storage.local.set({ [key]: Array.from(value) });
 *   }
 *
 *   async delete(key: string): Promise<void> {
 *     await chrome.storage.local.remove(key);
 *   }
 *
 *   async keys(prefix: string): Promise<string[]> {
 *     const all = await chrome.storage.local.get(null);
 *     return Object.keys(all).filter(k => k.startsWith(prefix));
 *   }
 * }
 *
 * // Use it
 * const persistence = createPersistence(new ChromeStorageAdapter());
 * ```
 */
export interface StorageAdapter {
  /**
   * Get a value by key.
   * @returns The value as Uint8Array, or undefined if not found
   */
  get(key: string): Promise<Uint8Array | undefined>;

  /**
   * Set a value by key.
   * @param key - Storage key
   * @param value - Binary data to store
   */
  set(key: string, value: Uint8Array): Promise<void>;

  /**
   * Delete a value by key.
   * @param key - Storage key to delete
   */
  delete(key: string): Promise<void>;

  /**
   * List all keys matching a prefix.
   * Used for listing updates for a collection.
   * @param prefix - Key prefix to match
   * @returns Array of matching keys
   */
  keys(prefix: string): Promise<string[]>;

  /**
   * Optional: Close/cleanup the storage connection.
   * Called when persistence is no longer needed.
   */
  close?(): void;
}

/**
 * Provider that persists Y.Doc state to storage.
 *
 * Created internally by Persistence.createDocPersistence().
 * Handles Y.Doc update observation and persistence.
 */
export interface PersistenceProvider {
  /** Promise that resolves when initial sync from storage completes */
  readonly whenSynced: Promise<void>;

  /** Clean up resources (stop observing, close connections) */
  destroy(): void;
}

/**
 * High-level persistence interface used by collections.
 *
 * This is what convexCollectionOptions expects. Create one using:
 * - persistence.sqlite.browser(SQL, name) - Browser with sql.js
 * - persistence.sqlite.native(db, name) - React Native with op-sqlite
 * - persistence.memory() - In-memory for testing
 * - persistence.custom(adapter) - Your own StorageAdapter implementation
 */
export interface Persistence {
  /** Create a Y.Doc persistence provider for a collection */
  createDocPersistence(collection: string, ydoc: Y.Doc): PersistenceProvider;

  /** Key-value store for metadata (checkpoints, clientID) */
  readonly kv: KeyValueStore;
}

/**
 * Simple key-value storage interface for metadata.
 *
 * Used for storing JSON-serializable metadata like checkpoints and client IDs.
 * This is a higher-level interface than StorageAdapter (handles JSON serialization).
 */
export interface KeyValueStore {
  /** Get a value by key */
  get<T>(key: string): Promise<T | undefined>;

  /** Set a value by key */
  set<T>(key: string, value: T): Promise<void>;

  /** Delete a value by key */
  del(key: string): Promise<void>;
}
