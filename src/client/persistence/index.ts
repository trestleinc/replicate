/**
 * Persistence layer exports.
 *
 * Provides swappable storage backends for Y.Doc and key-value data.
 */
export type { Persistence, PersistenceProvider, KeyValueStore } from './types.js';
export type { SqlitePersistenceOptions } from './sqlite.js';
export type { SqlJsStatic } from './sqlite-browser.js';
export type { SqliteAdapter } from './sqlite-level.js';

// Internal imports for the persistence object
import { indexeddbPersistence } from './indexeddb.js';
import { memoryPersistence } from './memory.js';
import { sqlitePersistence } from './sqlite.js';
import { createBrowserSqlitePersistence } from './sqlite-browser.js';
import { createReactNativeSqlitePersistence } from './sqlite-rn.js';

/**
 * Persistence API - nested object pattern for ergonomic access.
 *
 * @example
 * ```typescript
 * import { persistence } from '@trestleinc/replicate/client';
 *
 * // Browser SQLite (recommended for web)
 * const p = await persistence.sqlite.browser(SQL, 'myapp');
 *
 * // React Native SQLite
 * const p = await persistence.sqlite.native(db, 'myapp');
 *
 * // IndexedDB fallback
 * const p = persistence.indexeddb('myapp');
 *
 * // In-memory (testing)
 * const p = persistence.memory();
 * ```
 */
export const persistence = {
  /** IndexedDB-backed persistence (browser) */
  indexeddb: indexeddbPersistence,

  /** In-memory persistence (testing/ephemeral) */
  memory: memoryPersistence,

  /** SQLite persistence variants */
  sqlite: {
    /** Browser SQLite with OPFS (sql.js) */
    browser: createBrowserSqlitePersistence,
    /** React Native SQLite (op-sqlite) */
    native: createReactNativeSqlitePersistence,
    /** Custom SQLite adapter */
    create: sqlitePersistence,
  },
} as const;
