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
	type DocumentHandle,
	type DocumentPresence,
	type PresenceState,
	type SessionInfo,
	type SessionAPI,
} from '$/client/collection';

export type { DocFromSchema, TableNamesFromSchema, InferDoc } from '$/client/types';

export { identity, type UserIdentity, type AnonymousPresenceConfig } from '$/client/identity';

export { type Seq } from '$/client/services/seq';

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
import { emptyProse } from '$/client/validators';

export const schema = {
	prose: {
		extract,
		empty: emptyProse,
	},
} as const;

export {
	preloadLinks,
	injectPreloadLinks,
	compileWasmModule,
} from '$/client/persistence/sqlite/preload';

export {
	persistence,
	type StorageAdapter,
	type Persistence,
	type EncryptionPersistence,
	type EncryptionState,
	type WebEncryptionConfig,
	type NativeEncryptionConfig,
	type EncryptionManager,
	type EncryptionManagerConfig,
	type EncryptionManagerState,
	type EncryptionManagerHooks,
	type EncryptionPreference,
} from '$/client/persistence/index';

// Migration types and functions
export type {
	MigrationErrorCode,
	MigrationError,
	RecoveryContext,
	RecoveryAction,
	MigrationErrorHandler,
	MigrationDatabase,
	MigrationDoc,
	ClientMigrationContext,
	ClientMigrationFn,
	ClientMigrationMap,
	VersionedCollectionOptions,
	VersionedCollectionConfig,
	SchemaMetadata,
	RunMigrationsOptions,
	MigrationResult,
} from '$/client/migration';

export {
	runMigrations,
	getStoredSchemaVersion,
	setStoredSchemaVersion,
	runAutoMigration,
	createMigrationError,
} from '$/client/migration';
