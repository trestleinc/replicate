/**
 * sql.js adapter wrapper for browser SQLite.
 *
 * The consuming app imports sql.js and creates the database,
 * then passes it to this wrapper.
 *
 * @example
 * ```typescript
 * import initSqlJs from 'sql.js';
 * import { SqlJsAdapter } from '@trestleinc/replicate/client';
 *
 * const SQL = await initSqlJs({ locateFile: f => `/wasm/${f}` });
 * const db = new SQL.Database();
 * const adapter = new SqlJsAdapter(db, {
 *   onPersist: async (data) => {
 *     // Persist to OPFS, localStorage, etc.
 *   }
 * });
 * ```
 */
import type { SqliteAdapter } from '../sqlite-level.js';

/**
 * Interface for sql.js Database.
 * Consumer must install sql.js and pass a Database instance.
 */
export interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
  export(): Uint8Array;
  close(): void;
}

/**
 * Options for the SqlJsAdapter.
 */
export interface SqlJsAdapterOptions {
  /**
   * Callback to persist database after write operations.
   * Called with the exported database bytes.
   *
   * @example OPFS persistence
   * ```typescript
   * onPersist: async (data) => {
   *   const root = await navigator.storage.getDirectory();
   *   const handle = await root.getFileHandle('myapp.sqlite', { create: true });
   *   const writable = await handle.createWritable();
   *   await writable.write(data.buffer);
   *   await writable.close();
   * }
   * ```
   */
  onPersist?: (data: Uint8Array) => Promise<void>;
}

/**
 * Wraps a sql.js Database as a SqliteAdapter.
 *
 * @example
 * ```typescript
 * import initSqlJs from 'sql.js';
 * import { SqlJsAdapter } from '@trestleinc/replicate/client';
 *
 * const SQL = await initSqlJs();
 * const db = new SQL.Database();
 * const adapter = new SqlJsAdapter(db);
 * ```
 */
export class SqlJsAdapter implements SqliteAdapter {
  private db: SqlJsDatabase;
  private onPersist?: (data: Uint8Array) => Promise<void>;

  constructor(db: SqlJsDatabase, options: SqlJsAdapterOptions = {}) {
    this.db = db;
    this.onPersist = options.onPersist;
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const rows: Record<string, unknown>[] = [];

    // Handle statements that don't return data
    if (
      sql.trim().toUpperCase().startsWith('CREATE') ||
      sql.trim().toUpperCase().startsWith('INSERT') ||
      sql.trim().toUpperCase().startsWith('UPDATE') ||
      sql.trim().toUpperCase().startsWith('DELETE') ||
      sql.trim().toUpperCase().startsWith('BEGIN') ||
      sql.trim().toUpperCase().startsWith('COMMIT') ||
      sql.trim().toUpperCase().startsWith('ROLLBACK')
    ) {
      this.db.run(sql, params);
      await this.persist();
      return { rows };
    }

    // Handle SELECT statements
    const stmt = this.db.prepare(sql);
    if (params && params.length > 0) {
      stmt.bind(params);
    }

    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();

    return { rows };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Persist database using the onPersist callback if provided.
   */
  private async persist(): Promise<void> {
    if (this.onPersist) {
      const data = this.db.export();
      await this.onPersist(new Uint8Array(data));
    }
  }
}
