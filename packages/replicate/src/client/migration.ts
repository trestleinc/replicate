/**
 * Client Migration System
 *
 * Handles automatic client-side migrations based on schema diffs.
 * Runs SQLite migrations and Yjs document updates.
 */

import type { SchemaDiff, SchemaDiffOperation, VersionedSchema } from "$/server/migration";
import type { GenericValidator } from "convex/values";
import type { MigrationDatabase } from "$/client/persistence/types";

// Re-export MigrationDatabase from types
export type { MigrationDatabase } from "$/client/persistence/types";

// ─────────────────────────────────────────────────────────────────────────────
// Migration Error Types
// ─────────────────────────────────────────────────────────────────────────────

/** Error codes for migration failures */
export type MigrationErrorCode = "SCHEMA_MISMATCH" | "SQLITE_ERROR" | "YJS_ERROR" | "NETWORK_ERROR";

/** Error details for migration failures */
export interface MigrationError {
	code: MigrationErrorCode;
	message: string;
	fromVersion: number;
	toVersion: number;
	operation?: SchemaDiffOperation;
}

/** Context for migration error recovery */
export interface RecoveryContext {
	error: MigrationError;
	/** True if no unsynced local changes exist */
	canResetSafely: boolean;
	/** Count of unsynced local changes */
	pendingChanges: number;
	/** Timestamp of last successful sync */
	lastSyncedAt: Date | null;
}

/** Available recovery actions */
export type RecoveryAction =
	| { action: "reset" }
	| { action: "keep-old-schema" }
	| { action: "retry" }
	| { action: "custom"; handler: () => Promise<void> };

/** Handler for migration errors */
export type MigrationErrorHandler = (
	error: MigrationError,
	context: RecoveryContext,
) => Promise<RecoveryAction>;

/** Yjs document info for migrations */
export interface MigrationDoc {
	id: string;
	fields: Map<string, unknown>;
}

/** Context for custom client migrations */
export interface ClientMigrationContext {
	/** Documents that need migration */
	dirtyDocs: MigrationDoc[];
	/** Get Yjs document for a specific ID */
	getYDoc(id: string): import("yjs").Doc | null;
	/** Schema diff being applied */
	diff: SchemaDiff;
}

/** Custom client migration function */
export type ClientMigrationFn = (
	db: MigrationDatabase,
	ctx: ClientMigrationContext,
) => Promise<void>;

/** Map of version numbers to custom client migrations */
export type ClientMigrationMap = Record<number, ClientMigrationFn>;

// ─────────────────────────────────────────────────────────────────────────────
// Versioned Collection Options
// ─────────────────────────────────────────────────────────────────────────────

/** Options for collection.create() with versioned schema */
export interface VersionedCollectionOptions<T extends object> {
	/** Versioned schema definition */
	schema: VersionedSchema<GenericValidator>;
	/** Persistence provider factory */
	persistence: () => Promise<import("$/client/persistence/types").Persistence>;
	/** Collection configuration */
	config: () => VersionedCollectionConfig<T>;
	/** Custom client migrations (override auto-generated) */
	clientMigrations?: ClientMigrationMap;
	/** Handler for migration errors */
	onMigrationError?: MigrationErrorHandler;
}

/** Configuration for versioned collection */
export interface VersionedCollectionConfig<T extends object> {
	/** Convex client instance */
	convexClient: import("convex/browser").ConvexClient;
	/** Collection API endpoints */
	api: {
		material: import("convex/server").FunctionReference<"query">;
		delta: import("convex/server").FunctionReference<"query">;
		replicate: import("convex/server").FunctionReference<"mutation">;
		presence: import("convex/server").FunctionReference<"mutation">;
		session: import("convex/server").FunctionReference<"query">;
	};
	/** Get document key */
	getKey: (doc: T) => string | number;
	/** User identity provider */
	user?: () => import("$/client/identity").UserIdentity | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Runner
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata stored in SQLite for schema versioning */
export interface SchemaMetadata {
	collection: string;
	version: number;
	migratedAt: number;
}

/**
 * Get the current schema version from SQLite.
 */
export async function getStoredSchemaVersion(
	db: MigrationDatabase,
	collection: string,
): Promise<number | null> {
	try {
		const result = await db.get<{ version: number }>(
			`SELECT version FROM __replicate_schema WHERE collection = ?`,
			[collection],
		);
		return result?.version ?? null;
	} catch {
		// Table doesn't exist yet
		return null;
	}
}

/**
 * Store the current schema version in SQLite.
 */
export async function setStoredSchemaVersion(
	db: MigrationDatabase,
	collection: string,
	version: number,
): Promise<void> {
	await db.exec(`
		CREATE TABLE IF NOT EXISTS __replicate_schema (
			collection TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			migratedAt INTEGER NOT NULL
		)
	`);

	await db.run(
		`INSERT OR REPLACE INTO __replicate_schema (collection, version, migratedAt) VALUES (?, ?, ?)`,
		[collection, version, Date.now()],
	);
}

/**
 * Run auto-generated SQL migration.
 */
export async function runAutoMigration(
	db: MigrationDatabase,
	tableName: string,
	diff: SchemaDiff,
): Promise<void> {
	for (const sql of diff.generatedSQL) {
		const resolvedSql = sql.replace(/%TABLE%/g, `"${tableName}"`);
		await db.exec(resolvedSql);
	}
}

/**
 * Create a migration error.
 */
export function createMigrationError(
	code: MigrationErrorCode,
	message: string,
	fromVersion: number,
	toVersion: number,
	operation?: SchemaDiffOperation,
): MigrationError {
	return { code, message, fromVersion, toVersion, operation };
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Execution
// ─────────────────────────────────────────────────────────────────────────────

/** Options for running migrations */
export interface RunMigrationsOptions<_T extends object = object> {
	/** Collection name */
	collection: string;
	/** Versioned schema */
	schema: VersionedSchema<GenericValidator>;
	/** SQLite database interface */
	db: MigrationDatabase;
	/** Custom client migrations (override auto-generated) */
	clientMigrations?: ClientMigrationMap;
	/** Handler for migration errors */
	onError?: MigrationErrorHandler;
	/** Get Yjs document for a specific ID (for custom migrations) */
	getYDoc?: (id: string) => import("yjs").Doc | null;
	/** List all document IDs in the collection */
	listDocuments?: () => Promise<string[]>;
}

/** Result of running migrations */
export interface MigrationResult {
	/** Whether migration was needed and ran */
	migrated: boolean;
	/** Previous schema version (null if first run) */
	fromVersion: number | null;
	/** Current schema version */
	toVersion: number;
	/** Schema diff that was applied (null if no migration needed) */
	diff: SchemaDiff | null;
	/** Error if migration failed */
	error?: MigrationError;
}

/**
 * Run migrations for a collection if needed.
 *
 * @example
 * ```typescript
 * const result = await runMigrations({
 *   collection: "tasks",
 *   schema: taskSchema,
 *   db: persistence.db!,
 * });
 *
 * if (result.migrated) {
 *   console.log(`Migrated from v${result.fromVersion} to v${result.toVersion}`);
 * }
 * ```
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
	const { collection, schema, db, clientMigrations, onError, getYDoc, listDocuments } = options;
	const targetVersion = schema.version;

	// Get stored schema version
	const storedVersion = await getStoredSchemaVersion(db, collection);

	// First run - no migration needed, just store version
	if (storedVersion === null) {
		await setStoredSchemaVersion(db, collection, targetVersion);
		return {
			migrated: false,
			fromVersion: null,
			toVersion: targetVersion,
			diff: null,
		};
	}

	// Already at target version
	if (storedVersion === targetVersion) {
		return {
			migrated: false,
			fromVersion: storedVersion,
			toVersion: targetVersion,
			diff: null,
		};
	}

	// Compute diff between stored and target versions
	let diff: SchemaDiff;
	try {
		diff = schema.diff(storedVersion, targetVersion);
	} catch (err) {
		const error = createMigrationError(
			"SCHEMA_MISMATCH",
			`Failed to compute schema diff: ${err instanceof Error ? err.message : String(err)}`,
			storedVersion,
			targetVersion,
		);

		if (onError) {
			const recovery = await handleMigrationError(error, db, collection, onError);
			if (recovery.action === "keep-old-schema") {
				return {
					migrated: false,
					fromVersion: storedVersion,
					toVersion: storedVersion,
					diff: null,
					error,
				};
			}
		}

		throw err;
	}

	// Run migrations
	try {
		// Check for custom client migration for target version
		const customMigration = clientMigrations?.[targetVersion];

		if (customMigration) {
			// Run custom migration
			const docIds = listDocuments ? await listDocuments() : [];

			// Build dirtyDocs list from document IDs
			// Note: field data must be populated by getYDoc if needed
			const dirtyDocs: MigrationDoc[] = docIds.map(id => ({
				id,
				fields: new Map(),
			}));

			const ctx: ClientMigrationContext = {
				dirtyDocs,
				getYDoc: getYDoc ?? (() => null),
				diff,
			};

			await customMigration(db, ctx);
		} else {
			// Run auto-generated SQL migrations
			// Use collection name as table name for document storage
			await runAutoMigration(db, collection, diff);
		}

		// Update stored version
		await setStoredSchemaVersion(db, collection, targetVersion);

		return {
			migrated: true,
			fromVersion: storedVersion,
			toVersion: targetVersion,
			diff,
		};
	} catch (err) {
		const error = createMigrationError(
			"SQLITE_ERROR",
			`Migration failed: ${err instanceof Error ? err.message : String(err)}`,
			storedVersion,
			targetVersion,
		);

		if (onError) {
			const recovery = await handleMigrationError(error, db, collection, onError);
			if (recovery.action === "keep-old-schema") {
				return {
					migrated: false,
					fromVersion: storedVersion,
					toVersion: storedVersion,
					diff: null,
					error,
				};
			}
			if (recovery.action === "reset") {
				// Clear all data and set to target version
				await clearCollectionData(db, collection);
				await setStoredSchemaVersion(db, collection, targetVersion);
				return {
					migrated: true,
					fromVersion: storedVersion,
					toVersion: targetVersion,
					diff,
					error,
				};
			}
			if (recovery.action === "custom" && recovery.handler) {
				await recovery.handler();
				return {
					migrated: true,
					fromVersion: storedVersion,
					toVersion: targetVersion,
					diff,
				};
			}
		}

		throw err;
	}
}

/**
 * Handle migration error by calling user's error handler.
 */
async function handleMigrationError(
	error: MigrationError,
	db: MigrationDatabase,
	collection: string,
	onError: MigrationErrorHandler,
): Promise<RecoveryAction> {
	// Check for pending changes by looking at deltas table
	let pendingChanges = 0;
	try {
		const result = await db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM deltas WHERE collection LIKE ?`,
			[`${collection}:%`],
		);
		pendingChanges = result?.count ?? 0;
	} catch {
		// Ignore - table might not exist
	}

	// Get last sync timestamp from kv
	let lastSyncedAt: Date | null = null;
	try {
		const result = await db.get<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [
			`lastSync:${collection}`,
		]);
		if (result?.value) {
			const timestamp = JSON.parse(result.value);
			lastSyncedAt = new Date(timestamp);
		}
	} catch {
		// Ignore
	}

	const context: RecoveryContext = {
		error,
		canResetSafely: pendingChanges === 0,
		pendingChanges,
		lastSyncedAt,
	};

	return onError(error, context);
}

/**
 * Clear all data for a collection (used by reset recovery action).
 */
async function clearCollectionData(db: MigrationDatabase, collection: string): Promise<void> {
	// Clear snapshots
	await db.run(`DELETE FROM snapshots WHERE collection LIKE ?`, [`${collection}:%`]);

	// Clear deltas
	await db.run(`DELETE FROM deltas WHERE collection LIKE ?`, [`${collection}:%`]);

	// Clear related kv entries
	await db.run(`DELETE FROM kv WHERE key LIKE ?`, [`cursor:${collection}%`]);
}
