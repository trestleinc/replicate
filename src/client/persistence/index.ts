/**
 * Persistence layer exports.
 *
 * Provides swappable storage backends for Y.Doc and key-value data.
 */
export type { Persistence, PersistenceProvider, KeyValueStore } from './types.js';
export { indexeddbPersistence } from './indexeddb.js';
export { memoryPersistence } from './memory.js';
export { sqlitePersistence } from './sqlite.js';
