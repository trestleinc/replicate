/**
 * SQLite adapter wrappers for different platforms.
 *
 * These are wrapper classes - the consuming app imports and initializes
 * the actual database packages, then passes them to these wrappers.
 */
export { SqlJsAdapter, type SqlJsDatabase, type SqlJsAdapterOptions } from './sqljs.js';
export { OPSqliteAdapter, type OPSQLiteDatabase } from './opsqlite.js';
