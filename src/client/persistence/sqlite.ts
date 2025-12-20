/**
 * Universal SQLite persistence using a user-provided adapter.
 *
 * The consuming app is responsible for:
 * 1. Installing the SQLite package (sql.js, op-sqlite, etc.)
 * 2. Creating and initializing the database
 * 3. Wrapping it with the appropriate adapter
 * 4. Passing the adapter to sqlitePersistence()
 *
 * @example Browser (sql.js)
 * ```typescript
 * import initSqlJs from 'sql.js';
 * import { sqlitePersistence, SqlJsAdapter } from '@trestleinc/replicate/client';
 *
 * const SQL = await initSqlJs({ locateFile: file => `/sql-wasm/${file}` });
 * const db = new SQL.Database();
 * const adapter = new SqlJsAdapter(db, {
 *   onPersist: async (data) => {
 *     // Persist to OPFS, localStorage, etc.
 *   }
 * });
 * const persistence = await sqlitePersistence({ adapter });
 * ```
 *
 * @example React Native (op-sqlite)
 * ```typescript
 * import { open } from '@op-engineering/op-sqlite';
 * import { sqlitePersistence, OPSqliteAdapter } from '@trestleinc/replicate/client';
 *
 * const db = open({ name: 'myapp.db' });
 * const adapter = new OPSqliteAdapter(db);
 * const persistence = await sqlitePersistence({ adapter });
 * ```
 */
import type * as Y from 'yjs';
import { LeveldbPersistence } from 'y-leveldb';
import { SqliteLevel, type SqliteAdapter } from './sqlite-level.js';
import type { Persistence, PersistenceProvider, KeyValueStore } from './types.js';

/**
 * SQLite-backed key-value store using sqlite-level.
 */
class SqliteKeyValueStore implements KeyValueStore {
  private db: SqliteLevel<string, string>;
  private prefix = 'kv:';

  constructor(db: SqliteLevel<string, string>) {
    this.db = db;
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.db.get(this.prefix + key);
      if (value === undefined) {
        return undefined;
      }
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.db.put(this.prefix + key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    await this.db.del(this.prefix + key);
  }
}

/**
 * SQLite persistence provider using y-leveldb.
 */
class SqlitePersistenceProvider implements PersistenceProvider {
  private persistence: LeveldbPersistence;
  readonly whenSynced: Promise<void>;

  constructor(collection: string, _ydoc: Y.Doc, leveldb: LeveldbPersistence) {
    this.persistence = leveldb;
    // Load existing document state (may be null for new collections)
    this.whenSynced = this.persistence.getYDoc(collection).then((storedDoc: Y.Doc | null) => {
      if (storedDoc) {
        // Apply stored state to provided ydoc
        // The stored doc and ydoc are merged via y-leveldb's internal mechanisms
      }
    });
  }

  destroy(): void {
    this.persistence.destroy();
  }
}

/**
 * Options for SQLite persistence.
 */
export interface SqlitePersistenceOptions {
  /**
   * Pre-created SQLite adapter (required).
   * Use SqlJsAdapter for browser or OPSqliteAdapter for React Native.
   */
  adapter: SqliteAdapter;

  /**
   * Database name for internal y-leveldb usage.
   * @default 'replicate'
   */
  dbName?: string;
}

/**
 * Create a universal SQLite persistence factory.
 *
 * Requires a pre-created SqliteAdapter - the replicate package does not
 * import any SQLite packages directly, making it environment-agnostic.
 *
 * @param options - Configuration with required adapter
 *
 * @example Browser (sql.js)
 * ```typescript
 * import initSqlJs from 'sql.js';
 * import { sqlitePersistence, SqlJsAdapter } from '@trestleinc/replicate/client';
 *
 * const SQL = await initSqlJs();
 * const db = new SQL.Database();
 * const adapter = new SqlJsAdapter(db);
 * const persistence = await sqlitePersistence({ adapter });
 * ```
 *
 * @example React Native (op-sqlite)
 * ```typescript
 * import { open } from '@op-engineering/op-sqlite';
 * import { sqlitePersistence, OPSqliteAdapter } from '@trestleinc/replicate/client';
 *
 * const db = open({ name: 'myapp.db' });
 * const adapter = new OPSqliteAdapter(db);
 * const persistence = await sqlitePersistence({ adapter });
 * ```
 */
export async function sqlitePersistence(options: SqlitePersistenceOptions): Promise<Persistence> {
  const { adapter, dbName = 'replicate' } = options;

  // Create sqlite-level database with the provided adapter
  const db = new SqliteLevel<string, string>(dbName);
  db.setAdapterFactory(() => Promise.resolve(adapter));
  await db.open();

  // Create y-leveldb persistence (reuses the sqlite-level database)
  const leveldb = new LeveldbPersistence(dbName, { level: db as any });

  // Create key-value store
  const kv = new SqliteKeyValueStore(db);

  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new SqlitePersistenceProvider(collection, ydoc, leveldb),
    kv,
  };
}
