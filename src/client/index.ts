export {
  convexCollectionOptions,
  type ConvexCollection,
  type EditorBinding,
} from '$/client/collection';

import {
  NetworkError,
  IDBError,
  IDBWriteError,
  ReconciliationError,
  ProseError,
  CollectionNotReadyError,
  NonRetriableError,
} from '$/client/errors';

export const errors = {
  Network: NetworkError,
  IDB: IDBError,
  IDBWrite: IDBWriteError,
  Reconciliation: ReconciliationError,
  Prose: ProseError,
  CollectionNotReady: CollectionNotReadyError,
  NonRetriable: NonRetriableError,
} as const;

import { extract } from '$/client/merge';
import { prose as proseSchema } from '$/client/prose-schema';

export const prose = Object.assign(proseSchema, { extract });

export {
  persistence,
  type Persistence,
  type PersistenceProvider,
  type KeyValueStore,
  type SqlitePersistenceOptions,
  type SqliteAdapter,
  type SqlJsStatic,
} from '$/client/persistence/index';

import {
  SqlJsAdapter,
  OPSqliteAdapter,
} from '$/client/persistence/adapters/index';

export const adapters = {
  sqljs: SqlJsAdapter,
  opsqlite: OPSqliteAdapter,
} as const;

export type {
  SqlJsDatabase,
  SqlJsAdapterOptions,
  OPSQLiteDatabase,
} from '$/client/persistence/adapters/index';
