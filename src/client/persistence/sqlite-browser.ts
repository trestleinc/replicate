/**
 * Browser SQLite persistence helper using sql.js and OPFS.
 *
 * Handles all the boilerplate for browser SQLite:
 * - Loading existing database from OPFS
 * - Persisting to OPFS on every write
 * - Creating the SqlJsAdapter
 *
 * @example
 * ```typescript
 * import { createBrowserSqlitePersistence } from '@trestleinc/replicate/client';
 * import initSqlJs from 'sql.js';
 *
 * const SQL = await initSqlJs({ locateFile: f => `https://sql.js.org/dist/${f}` });
 * const persistence = await createBrowserSqlitePersistence(SQL, 'myapp');
 * ```
 */
import { SqlJsAdapter, type SqlJsDatabase } from './adapters/sqljs.js';
import { sqlitePersistence } from './sqlite.js';
import type { Persistence } from './types.js';

/**
 * Interface for the sql.js module (the result of initSqlJs).
 */
export interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

/**
 * Load existing database from OPFS if available.
 */
async function loadFromOPFS(dbName: string): Promise<Uint8Array | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(`${dbName}.sqlite`);
    const file = await handle.getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    // File doesn't exist yet
    return null;
  }
}

/**
 * Save database to OPFS for durable storage.
 */
function createOPFSSaver(dbName: string): (data: Uint8Array) => Promise<void> {
  return async (data: Uint8Array): Promise<void> => {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(`${dbName}.sqlite`, { create: true });
      const writable = await handle.createWritable();
      // Copy to a new ArrayBuffer to satisfy TypeScript's strict ArrayBuffer type
      const buffer = new ArrayBuffer(data.length);
      new Uint8Array(buffer).set(data);
      await writable.write(buffer);
      await writable.close();
    } catch {
      // Silently fail - OPFS may not be available
    }
  };
}

/**
 * Create browser SQLite persistence with OPFS storage.
 *
 * This helper handles all the OPFS boilerplate:
 * - Loads existing database from OPFS on init
 * - Persists to OPFS after every write operation
 *
 * @param SQL - The initialized sql.js module (from `await initSqlJs()`)
 * @param dbName - Name for the database (used for OPFS filename: `{dbName}.sqlite`)
 *
 * @example
 * ```typescript
 * import { createBrowserSqlitePersistence } from '@trestleinc/replicate/client';
 * import initSqlJs from 'sql.js';
 *
 * const SQL = await initSqlJs({ locateFile: f => `https://sql.js.org/dist/${f}` });
 * const persistence = await createBrowserSqlitePersistence(SQL, 'intervals');
 *
 * // Use in collection options
 * convexCollectionOptions<Task>({
 *   // ...
 *   persistence,
 * });
 * ```
 */
export async function createBrowserSqlitePersistence(
  SQL: SqlJsStatic,
  dbName: string
): Promise<Persistence> {
  // Load existing database from OPFS if available
  const existingData = await loadFromOPFS(dbName);

  // Create database (with existing data if found)
  const db = existingData ? new SQL.Database(existingData) : new SQL.Database();

  // Create adapter with OPFS persistence
  const adapter = new SqlJsAdapter(db, {
    onPersist: createOPFSSaver(dbName),
  });

  // Create and return persistence
  return sqlitePersistence({ adapter, dbName });
}
