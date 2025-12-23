export { collection, type EditorBinding, type ConvexCollection, type Materialized } from "$/client/collection";

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

import type { ProseValue } from "$/shared/types";
import { extract } from "$/client/merge";
import { prose as proseSchema } from "$/client/prose-schema";

function empty(): ProseValue {
  return { type: "doc", content: [] } as unknown as ProseValue;
}

export const prose = Object.assign(proseSchema, { extract, empty });

export { persistence, type StorageAdapter, type Persistence } from "$/client/persistence/index";
