import type * as Y from "yjs";

/**
 * Low-level storage adapter for custom backends (Chrome extension, localStorage, cloud).
 * For SQLite, use `persistence.sqlite()` directly.
 *
 * @example
 * ```typescript
 * class ChromeStorageAdapter implements StorageAdapter {
 *   async get(key: string) {
 *     const result = await chrome.storage.local.get(key);
 *     return result[key] ? new Uint8Array(result[key]) : undefined;
 *   }
 *   async set(key: string, value: Uint8Array) {
 *     await chrome.storage.local.set({ [key]: Array.from(value) });
 *   }
 *   async delete(key: string) {
 *     await chrome.storage.local.remove(key);
 *   }
 *   async keys(prefix: string) {
 *     const all = await chrome.storage.local.get(null);
 *     return Object.keys(all).filter(k => k.startsWith(prefix));
 *   }
 * }
 * ```
 */
export interface StorageAdapter {
	get(key: string): Promise<Uint8Array | undefined>;
	set(key: string, value: Uint8Array): Promise<void>;
	delete(key: string): Promise<void>;
	keys(prefix: string): Promise<string[]>;
	close?(): void;
}

export interface PersistenceProvider {
	readonly whenSynced: Promise<void>;
	destroy(): void;
}

/**
 * High-level persistence interface for collections.
 * Create via `persistence.sqlite()`, `persistence.memory()`, or `persistence.custom()`.
 */
export interface Persistence {
	createDocPersistence(collection: string, ydoc: Y.Doc): PersistenceProvider;
	listDocuments(prefix: string): Promise<string[]>;
	readonly kv: KeyValueStore;
}

export interface KeyValueStore {
	get<T>(key: string): Promise<T | undefined>;
	set<T>(key: string, value: T): Promise<void>;
	del(key: string): Promise<void>;
}
