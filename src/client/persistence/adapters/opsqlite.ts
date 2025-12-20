/**
 * op-sqlite adapter wrapper for React Native SQLite.
 *
 * The consuming app imports @op-engineering/op-sqlite and opens the database,
 * then passes it to this wrapper.
 *
 * @example
 * ```typescript
 * import { open } from '@op-engineering/op-sqlite';
 * import { OPSqliteAdapter } from '@trestleinc/replicate/client';
 *
 * const db = open({ name: 'myapp.db' });
 * const adapter = new OPSqliteAdapter(db);
 * ```
 */
import type { SqliteAdapter } from '../sqlite-level.js';

/**
 * Interface for op-sqlite Database.
 * Consumer must install @op-engineering/op-sqlite and pass a Database instance.
 */
export interface OPSQLiteDatabase {
  execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

/**
 * Wraps an op-sqlite Database as a SqliteAdapter.
 *
 * @example
 * ```typescript
 * import { open } from '@op-engineering/op-sqlite';
 * import { OPSqliteAdapter } from '@trestleinc/replicate/client';
 *
 * const db = open({ name: 'myapp.db' });
 * const adapter = new OPSqliteAdapter(db);
 * ```
 */
export class OPSqliteAdapter implements SqliteAdapter {
  private db: OPSQLiteDatabase;

  constructor(db: OPSQLiteDatabase) {
    this.db = db;
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const result = await this.db.execute(sql, params);
    return { rows: result.rows || [] };
  }

  close(): void {
    this.db.close();
  }
}
