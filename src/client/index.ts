export {
  convexCollectionOptions,
  type ConvexCollection,
  type EditorBinding,
} from '$/client/collection.js';

import {
  NetworkError,
  IDBError,
  IDBWriteError,
  ReconciliationError,
  ProseError,
  CollectionNotReadyError,
  NonRetriableError,
} from '$/client/errors.js';

export const errors = {
  Network: NetworkError,
  IDB: IDBError,
  IDBWrite: IDBWriteError,
  Reconciliation: ReconciliationError,
  Prose: ProseError,
  CollectionNotReady: CollectionNotReadyError,
  NonRetriable: NonRetriableError,
} as const;

import { extract } from '$/client/merge.js';

export const prose = {
  extract,
} as const;

export {
  persistence,
  type Persistence,
  type PersistenceProvider,
  type KeyValueStore,
  type SqlitePersistenceOptions,
  type SqliteAdapter,
  type SqlJsStatic,
} from '$/client/persistence/index.js';

import {
  SqlJsAdapter,
  OPSqliteAdapter,
} from '$/client/persistence/adapters/index.js';

export const adapters = {
  sqljs: SqlJsAdapter,
  opsqlite: OPSqliteAdapter,
} as const;

export type {
  SqlJsDatabase,
  SqlJsAdapterOptions,
  OPSQLiteDatabase,
} from '$/client/persistence/adapters/index.js';
