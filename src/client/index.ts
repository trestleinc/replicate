export {
  collection,
  type EditorBinding,
  type ConvexCollection,
  type Materialized,
  type ProseOptions,
} from "$/client/collection";

export { type UserIdentity } from "$/client/services/awareness";

export { type Seq } from "$/client/services/seq";

import {
  NetworkError,
  IDBError,
  IDBWriteError,
  ReconciliationError,
  ProseError,
  CollectionNotReadyError,
  NonRetriableError,
} from "$/client/errors";

export const errors = {
  Network: NetworkError,
  IDB: IDBError,
  IDBWrite: IDBWriteError,
  Reconciliation: ReconciliationError,
  Prose: ProseError,
  CollectionNotReady: CollectionNotReadyError,
  NonRetriable: NonRetriableError,
} as const;

import { extract } from "$/client/merge";
import { prose as proseSchema } from "$/client/prose";

export const prose = Object.assign(proseSchema, { extract });

export { persistence, type StorageAdapter, type Persistence } from "$/client/persistence/index";
