export {
	collection,
	type EditorBinding,
	type ConvexCollection,
	type LazyCollection,
	type Materialized,
	type ProseOptions,
} from "$/client/collection";

export type { DocFromSchema, TableNamesFromSchema, InferDoc } from "$/client/types";

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
import { emptyProse } from "$/client/validators";

export const schema = {
	prose: {
		extract,
		empty: emptyProse,
	},
} as const;

export { persistence, type StorageAdapter, type Persistence } from "$/client/persistence/index";
