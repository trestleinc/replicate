/**
 * In-memory persistence implementation for testing.
 *
 * State is not persisted across sessions - useful for tests and development.
 */
import type * as Y from "yjs";
import type { Persistence, PersistenceProvider, KeyValueStore } from "./types.js";

/**
 * In-memory key-value store.
 */
class MemoryKeyValueStore implements KeyValueStore {
	private store = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.store.get(key) as T | undefined;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.store.set(key, value);
	}

	async del(key: string): Promise<void> {
		this.store.delete(key);
	}
}

/**
 * No-op persistence provider for in-memory usage.
 *
 * The Y.Doc is kept in memory without persistence.
 */
class MemoryPersistenceProvider implements PersistenceProvider {
	readonly whenSynced = Promise.resolve();

	destroy(): void {
		// No resources to clean up
	}
}

/**
 * Create an in-memory persistence factory.
 *
 * Useful for testing where you don't want IndexedDB side effects.
 *
 * @example
 * ```typescript
 * // In tests
 * convexCollectionOptions<Task>({
 *   // ... other options
 *   persistence: memoryPersistence(),
 * });
 * ```
 */
export function memoryPersistence(): Persistence {
	const kv = new MemoryKeyValueStore();
	return {
		createDocPersistence: (_: string, __: Y.Doc) => new MemoryPersistenceProvider(),
		async listDocuments(_prefix: string): Promise<string[]> {
			return [];
		},
		kv,
	};
}
