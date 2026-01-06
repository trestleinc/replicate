export {
	collection,
	type EditorBinding,
	type ConvexCollection,
	type LazyCollection,
	type Materialized,
	type PaginatedPage,
	type PaginatedMaterial,
	type PaginationConfig,
	type PaginationStatus,
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

export {
	persistence,
	isPRFSupported,
	type StorageAdapter,
	type Persistence,
	type EncryptedPersistence,
	type EncryptionState,
	type WebEncryptedConfig,
	type NativeEncryptedConfig,
} from "$/client/persistence/index";
