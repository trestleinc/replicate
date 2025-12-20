/**
 * React Native SQLite persistence helper using op-sqlite.
 *
 * @example
 * ```typescript
 * import { createReactNativeSqlitePersistence } from '@trestleinc/replicate/client';
 * import { open } from '@op-engineering/op-sqlite';
 *
 * const db = open({ name: 'myapp.db' });
 * const persistence = await createReactNativeSqlitePersistence(db, 'myapp');
 * ```
 */
import { OPSqliteAdapter, type OPSQLiteDatabase } from './adapters/opsqlite.js';
import { sqlitePersistence } from './sqlite.js';
import type { Persistence } from './types.js';

/**
 * Create React Native SQLite persistence using op-sqlite.
 *
 * @param db - The opened op-sqlite database instance
 * @param dbName - Name for internal database identification
 *
 * @example
 * ```typescript
 * import { createReactNativeSqlitePersistence } from '@trestleinc/replicate/client';
 * import { open } from '@op-engineering/op-sqlite';
 *
 * const db = open({ name: 'myapp.db' });
 * const persistence = await createReactNativeSqlitePersistence(db, 'myapp');
 *
 * // Use in collection options
 * convexCollectionOptions<Task>({
 *   // ...
 *   persistence,
 * });
 * ```
 */
export async function createReactNativeSqlitePersistence(
  db: OPSQLiteDatabase,
  dbName: string
): Promise<Persistence> {
  const adapter = new OPSqliteAdapter(db);
  return sqlitePersistence({ adapter, dbName });
}
