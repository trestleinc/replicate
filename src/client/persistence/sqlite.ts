/**
 * Universal SQLite persistence using direct Y.Doc storage.
 *
 * Stores Y.Doc state as blobs without any LevelDB abstraction:
 * - snapshots table: Full Y.Doc state (Y.encodeStateAsUpdate)
 * - updates table: Incremental updates (before compaction)
 * - kv table: Key-value metadata (cursor, peerId, etc.)
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
import * as Y from "yjs";
import type { Persistence, PersistenceProvider, KeyValueStore } from "./types.js";

/**
 * Interface for SQLite database operations.
 * Abstracts over sql.js (browser) and op-sqlite (React Native).
 */
export interface SqliteAdapter {
  execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

/**
 * SQLite-backed key-value store.
 */
class SqliteKeyValueStore implements KeyValueStore {
  private adapter: SqliteAdapter;

  constructor(adapter: SqliteAdapter) {
    this.adapter = adapter;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.adapter.execute(
      "SELECT value FROM kv WHERE key = ?",
      [key],
    );
    if (result.rows.length === 0) {
      return undefined;
    }
    const value = result.rows[0].value as string;
    return JSON.parse(value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.adapter.execute(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      [key, JSON.stringify(value)],
    );
  }

  async del(key: string): Promise<void> {
    await this.adapter.execute("DELETE FROM kv WHERE key = ?", [key]);
  }
}

/**
 * SQLite persistence provider with direct Y.Doc storage.
 *
 * On initialization:
 * 1. Loads snapshot (if exists)
 * 2. Loads any pending updates
 * 3. Applies all to Y.Doc
 *
 * On updates:
 * - Stores incremental updates
 * - Can compact (merge updates into snapshot)
 */
class SqlitePersistenceProvider implements PersistenceProvider {
  private adapter: SqliteAdapter;
  private collection: string;
  private ydoc: Y.Doc;
  private updateHandler: (update: Uint8Array, origin: unknown) => void;
  readonly whenSynced: Promise<void>;

  constructor(adapter: SqliteAdapter, collection: string, ydoc: Y.Doc) {
    this.adapter = adapter;
    this.collection = collection;
    this.ydoc = ydoc;

    // Load existing state
    this.whenSynced = this.loadState();

    // Set up update listener to persist changes
    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      // Don't persist updates that came from loading (origin === 'sqlite')
      if (origin !== "sqlite") {
        void this.saveUpdate(update);
      }
    };
    this.ydoc.on("update", this.updateHandler);
  }

  /**
   * Load snapshot and pending updates, apply to Y.Doc.
   */
  private async loadState(): Promise<void> {
    // Load snapshot
    const snapshotResult = await this.adapter.execute(
      "SELECT data, state_vector, seq FROM snapshots WHERE collection = ?",
      [this.collection],
    );

    if (snapshotResult.rows.length > 0) {
      const row = snapshotResult.rows[0];
      const snapshotData = row.data as Uint8Array;
      Y.applyUpdate(this.ydoc, snapshotData, "sqlite");
    }

    // Load pending updates (ordered by id)
    const updatesResult = await this.adapter.execute(
      "SELECT data FROM updates WHERE collection = ? ORDER BY id ASC",
      [this.collection],
    );

    for (const row of updatesResult.rows) {
      const updateData = row.data as Uint8Array;
      Y.applyUpdate(this.ydoc, updateData, "sqlite");
    }
  }

  /**
   * Save an incremental update.
   */
  private async saveUpdate(update: Uint8Array): Promise<void> {
    await this.adapter.execute(
      "INSERT INTO updates (collection, data) VALUES (?, ?)",
      [this.collection, update],
    );
  }

  /**
   * Compact all updates into a snapshot.
   * Call this periodically to prevent unbounded growth.
   */
  async compact(): Promise<void> {
    // Get current full state
    const snapshot = Y.encodeStateAsUpdate(this.ydoc);
    const stateVector = Y.encodeStateVector(this.ydoc);

    // Get highest seq from updates (for tracking)
    const seqResult = await this.adapter.execute(
      "SELECT MAX(id) as maxId FROM updates WHERE collection = ?",
      [this.collection],
    );
    const seq = (seqResult.rows[0]?.maxId as number) ?? 0;

    // Store new snapshot
    await this.adapter.execute(
      "INSERT OR REPLACE INTO snapshots (collection, data, state_vector, seq) VALUES (?, ?, ?, ?)",
      [this.collection, snapshot, stateVector, seq],
    );

    // Delete all updates
    await this.adapter.execute(
      "DELETE FROM updates WHERE collection = ?",
      [this.collection],
    );
  }

  /**
   * Get the current state vector (for sync protocol).
   */
  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.ydoc);
  }

  /**
   * Get the full state as an update (for sending to server during compaction).
   */
  getFullState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
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
   * Database name (used for logging/debugging).
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
  const { adapter } = options;

  // Create tables
  await adapter.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      collection TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      state_vector BLOB,
      seq INTEGER DEFAULT 0
    )
  `);

  await adapter.execute(`
    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      data BLOB NOT NULL
    )
  `);

  await adapter.execute(`
    CREATE INDEX IF NOT EXISTS updates_collection_idx ON updates (collection)
  `);

  await adapter.execute(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const kv = new SqliteKeyValueStore(adapter);

  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new SqlitePersistenceProvider(adapter, collection, ydoc),
    kv,
  };
}
