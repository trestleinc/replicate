/**
 * SQLite persistence implementation for React Native.
 *
 * Uses y-op-sqlite for Y.Doc persistence and op-sqlite for key-value storage.
 *
 * @requires y-op-sqlite - Yjs persistence for React Native
 * @requires @op-engineering/op-sqlite - SQLite for React Native
 */
import type * as Y from 'yjs';
import { open, type QueryResult } from '@op-engineering/op-sqlite';
import { OPSQLitePersistence } from 'y-op-sqlite';
import type { Persistence, PersistenceProvider, KeyValueStore } from './types.js';

// Infer database type from the library
type OPSQLiteDB = ReturnType<typeof open>;

/**
 * SQLite-backed key-value store using op-sqlite.
 */
class SQLiteKeyValueStore implements KeyValueStore {
  private db: OPSQLiteDB;
  private initialized: Promise<void>;

  constructor(dbName: string) {
    // Validate database name (security: prevent path traversal)
    if (!/^[\w-]+$/.test(dbName)) {
      throw new Error('Invalid database name: must be alphanumeric with hyphens/underscores');
    }

    this.db = open({ name: `${dbName}.db` });
    this.initialized = this.init();
  }

  private async init(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.initialized;
    const result: QueryResult = await this.db.execute('SELECT value FROM kv WHERE key = ?', [key]);

    if (result.rows.length === 0) {
      return undefined;
    }
    // Access the 'value' column from the row record
    const row = result.rows[0];
    const value = row.value;
    if (typeof value !== 'string') {
      return undefined;
    }
    return JSON.parse(value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.initialized;
    await this.db.execute('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [
      key,
      JSON.stringify(value),
    ]);
  }

  async del(key: string): Promise<void> {
    await this.initialized;
    await this.db.execute('DELETE FROM kv WHERE key = ?', [key]);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * SQLite persistence provider wrapping y-op-sqlite.
 */
class SQLitePersistenceProvider implements PersistenceProvider {
  private persistence: OPSQLitePersistence;
  readonly whenSynced: Promise<void>;

  constructor(collection: string, ydoc: Y.Doc) {
    this.persistence = new OPSQLitePersistence(collection, ydoc);
    // OPSQLitePersistence.whenSynced returns Promise<this>, map to Promise<void>
    this.whenSynced = this.persistence.whenSynced.then(() => undefined);
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
export function sqlitePersistence(dbName = 'replicate-kv'): Persistence {
  const kv = new SQLiteKeyValueStore(dbName);
  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new SQLitePersistenceProvider(collection, ydoc),
    kv,
  };
}
