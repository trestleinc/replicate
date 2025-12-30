export {
  collection,
  type EditorBinding,
  type ConvexCollection,
  type Materialized,
} from "$/client/collection";

export { type Seq } from "$/client/services/cursor";

export {
  type CursorPosition,
  type ClientCursor,
  type UserProfile,
  createPresence,
} from "$/client/services/presence";

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
