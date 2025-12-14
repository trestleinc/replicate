/**
 * SQLite persistence implementation for React Native.
 *
 * Uses y-op-sqlite for Y.Doc persistence and op-sqlite for key-value storage.
 *
 * @requires y-op-sqlite - Yjs persistence for React Native
 * @requires @op-engineering/op-sqlite - SQLite for React Native
 */
import type * as Y from 'yjs';
import type { Persistence, PersistenceProvider, KeyValueStore } from './types.js';

// Lazy imports to avoid bundling React Native deps in browser builds
let OPSQLitePersistence: any;
let open: any;

/**
 * SQLite-backed key-value store using op-sqlite.
 */
class SQLiteKeyValueStore implements KeyValueStore {
  private db: any;
  private initialized: Promise<void>;

  constructor(dbName: string) {
    this.initialized = this.init(dbName);
  }

  private async init(dbName: string): Promise<void> {
    if (!open) {
      const opSqlite = await import('@op-engineering/op-sqlite');
      open = opSqlite.open;
    }
    this.db = open({ name: `${dbName}.db` });
    this.db.execute(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.initialized;
    const result = this.db.execute('SELECT value FROM kv WHERE key = ?', [key]);
    if (result.rows.length === 0) {
      return undefined;
    }
    return JSON.parse(result.rows[0].value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.initialized;
    this.db.execute('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [
      key,
      JSON.stringify(value),
    ]);
  }

  async del(key: string): Promise<void> {
    await this.initialized;
    this.db.execute('DELETE FROM kv WHERE key = ?', [key]);
  }

  close(): void {
    this.db?.close();
  }
}

/**
 * SQLite persistence provider wrapping y-op-sqlite.
 */
class SQLitePersistenceProvider implements PersistenceProvider {
  private persistence: any;
  readonly whenSynced: Promise<void>;

  constructor(collection: string, ydoc: Y.Doc) {
    // y-op-sqlite already exposes whenSynced as a Promise
    this.persistence = new OPSQLitePersistence(collection, ydoc);
    this.whenSynced = this.persistence.whenSynced;
  }

  destroy(): void {
    this.persistence.destroy();
  }
}

/**
 * Create a SQLite persistence factory for React Native.
 *
 * Uses y-op-sqlite for Y.Doc persistence and op-sqlite for metadata storage.
 *
 * @param dbName - Name for the SQLite database (default: 'replicate-kv')
 *
 * @example
 * ```typescript
 * // In a React Native app
 * import { convexCollectionOptions, sqlitePersistence } from '@trestleinc/replicate/client';
 *
 * convexCollectionOptions<Task>({
 *   // ... other options
 *   persistence: sqlitePersistence(),
 * });
 * ```
 */
export async function sqlitePersistence(dbName = 'replicate-kv'): Promise<Persistence> {
  // Lazy load y-op-sqlite to avoid bundling in browser
  if (!OPSQLitePersistence) {
    const yOpSqlite = await import('y-op-sqlite');
    OPSQLitePersistence = yOpSqlite.OPSQLitePersistence;
  }

  const kv = new SQLiteKeyValueStore(dbName);
  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new SQLitePersistenceProvider(collection, ydoc),
    kv,
  };
}
