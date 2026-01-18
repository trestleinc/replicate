/**
 * Deep tests for the versioned schema migration API.
 *
 * Tests the full migration flow using real Convex validators and schema diffing.
 * Each test verifies actual database state after operations.
 */

import { test, expect } from "vitest";
import { v } from "convex/values";
import { define } from "$/server/migration";
import {
	runMigrations,
	getStoredSchemaVersion,
	type MigrationErrorHandler,
	type ClientMigrationFn,
} from "$/client/migration";
import {
	createTestDatabase,
	setupDatabaseAtVersion,
	createTestTable,
} from "./helpers/test-database";

// ─────────────────────────────────────────────────────────────────────────────
// Test Schemas
// ─────────────────────────────────────────────────────────────────────────────

// v1: Basic task
const v1Schema = v.object({
	id: v.string(),
	title: v.string(),
	completed: v.boolean(),
});

// v2: Add priority field
const v2Schema = v.object({
	id: v.string(),
	title: v.string(),
	completed: v.boolean(),
	priority: v.optional(v.string()),
});

// v3: Add status, remove completed
const v3Schema = v.object({
	id: v.string(),
	title: v.string(),
	priority: v.string(),
	status: v.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Fresh Database
// ─────────────────────────────────────────────────────────────────────────────

test("migration_freshDatabase_storesVersionWithoutAlteringSchema", async () => {
	// Create versioned schema at v2
	const taskSchema = define({
		version: 2,
		shape: v2Schema,
		defaults: { priority: "medium" },
		history: { 1: v1Schema },
	});

	// Create fresh database (no existing schema version)
	const db = createTestDatabase();

	// Run migrations
	const result = await runMigrations({
		collection: "tasks",
		schema: taskSchema,
		db,
	});

	// Verify: migrated=false because it's first run (no upgrade needed)
	expect(result.migrated).toBe(false);
	expect(result.fromVersion).toBe(null);
	expect(result.toVersion).toBe(2);
	expect(result.diff).toBe(null);

	// Verify: __replicate_schema table was created with version=2
	expect(db.hasTable("__replicate_schema")).toBe(true);
	const storedVersion = await getStoredSchemaVersion(db, "tasks");
	expect(storedVersion).toBe(2);

	// Verify: No ALTER TABLE statements were executed
	const sqlStatements = db.getExecutedSQL();
	const alterStatements = sqlStatements.filter(sql => sql.includes("ALTER TABLE"));
	expect(alterStatements).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: v1 → v2 Migration
// ─────────────────────────────────────────────────────────────────────────────

test("migration_v1ToV2_addsColumnWithDefault", async () => {
	// Create versioned schema at v2
	const taskSchema = define({
		version: 2,
		shape: v2Schema,
		defaults: { priority: "medium" },
		history: { 1: v1Schema },
	});

	// Create database at v1 with existing table
	const db = createTestDatabase();
	await createTestTable(db, "tasks", {
		id: "TEXT",
		title: "TEXT",
		completed: "INTEGER",
	});

	// Manually set schema version to 1
	await setupDatabaseAtVersion(db, "tasks", 1);
	db.clearSQLHistory(); // Clear setup SQL

	// Run migrations
	const result = await runMigrations({
		collection: "tasks",
		schema: taskSchema,
		db,
	});

	// Verify: Migration ran
	expect(result.migrated).toBe(true);
	expect(result.fromVersion).toBe(1);
	expect(result.toVersion).toBe(2);

	// Verify: Diff contains add_column for priority
	expect(result.diff).not.toBe(null);
	expect(result.diff!.operations).toContainEqual({
		type: "add_column",
		column: "priority",
		fieldType: "string",
		defaultValue: "medium",
	});

	// Verify: Generated SQL includes ADD COLUMN
	expect(result.diff!.generatedSQL).toContainEqual(
		expect.stringContaining('ADD COLUMN "priority" TEXT DEFAULT'),
	);

	// Verify: ALTER TABLE was executed
	const sqlStatements = db.getExecutedSQL();
	const alterStatements = sqlStatements.filter(sql => sql.includes("ALTER TABLE"));
	expect(alterStatements.length).toBeGreaterThan(0);
	expect(alterStatements[0]).toContain("ADD COLUMN");
	expect(alterStatements[0]).toContain("priority");

	// Verify: Table now has priority column
	const columns = db.getTableColumns("tasks");
	expect(columns).toContain("priority");

	// Verify: Schema version updated to 2
	const storedVersion = await getStoredSchemaVersion(db, "tasks");
	expect(storedVersion).toBe(2);

	// Verify: isBackwardsCompatible since we're adding with default
	expect(result.diff!.isBackwardsCompatible).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: v1 → v3 Multi-Step Migration
// ─────────────────────────────────────────────────────────────────────────────

test("migration_v1ToV3_computesDiffAcrossMultipleVersions", async () => {
	// Create versioned schema at v3 with full history
	const taskSchema = define({
		version: 3,
		shape: v3Schema,
		defaults: { priority: "medium", status: "todo" },
		history: {
			1: v1Schema,
			2: v2Schema,
		},
	});

	// Create database at v1
	const db = createTestDatabase();
	await createTestTable(db, "tasks", {
		id: "TEXT",
		title: "TEXT",
		completed: "INTEGER",
	});
	await setupDatabaseAtVersion(db, "tasks", 1);
	db.clearSQLHistory();

	// Run migrations (v1 → v3, skipping v2)
	const result = await runMigrations({
		collection: "tasks",
		schema: taskSchema,
		db,
	});

	// Verify: Migration ran
	expect(result.migrated).toBe(true);
	expect(result.fromVersion).toBe(1);
	expect(result.toVersion).toBe(3);

	// Verify: Diff detects all changes from v1 to v3
	expect(result.diff).not.toBe(null);
	const ops = result.diff!.operations;

	// Should have: add(priority), add(status), remove(completed)
	const addOps = ops.filter(op => op.type === "add_column");
	const removeOps = ops.filter(op => op.type === "remove_column");

	expect(addOps).toContainEqual(
		expect.objectContaining({ type: "add_column", column: "priority" }),
	);
	expect(addOps).toContainEqual(expect.objectContaining({ type: "add_column", column: "status" }));
	expect(removeOps).toContainEqual(
		expect.objectContaining({ type: "remove_column", column: "completed" }),
	);

	// Verify: Generated SQL includes both ADD and DROP
	const sql = result.diff!.generatedSQL;
	expect(sql.some(s => s.includes("ADD COLUMN") && s.includes("priority"))).toBe(true);
	expect(sql.some(s => s.includes("ADD COLUMN") && s.includes("status"))).toBe(true);
	expect(sql.some(s => s.includes("DROP COLUMN") && s.includes("completed"))).toBe(true);

	// Verify: isBackwardsCompatible = false (because of remove)
	expect(result.diff!.isBackwardsCompatible).toBe(false);

	// Verify: Table has new columns
	const columns = db.getTableColumns("tasks");
	expect(columns).toContain("priority");
	expect(columns).toContain("status");
	expect(columns).not.toContain("completed");
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Error Recovery
// ─────────────────────────────────────────────────────────────────────────────

test("migration_sqlError_callsErrorHandlerAndRecovers", async () => {
	// Create versioned schema
	const taskSchema = define({
		version: 2,
		shape: v2Schema,
		defaults: { priority: "medium" },
		history: { 1: v1Schema },
	});

	// Create database at v1 (but WITHOUT the tasks table - will cause ALTER error)
	const db = createTestDatabase();
	await setupDatabaseAtVersion(db, "tasks", 1);

	// Set up tables for recovery context
	await db.exec(`CREATE TABLE deltas (id TEXT, collection TEXT)`);
	await db.exec(`CREATE TABLE snapshots (id TEXT, collection TEXT)`);
	await db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)`);

	db.clearSQLHistory();

	// Inject error to simulate SQL failure
	db.injectError(new Error("no such table: tasks"));

	// Track error handler calls
	const errorHandlerCalls: Array<{ error: unknown; context: unknown }> = [];
	const onError: MigrationErrorHandler = async (error, context) => {
		errorHandlerCalls.push({ error, context });
		return { action: "reset" };
	};

	// Run migrations
	const result = await runMigrations({
		collection: "tasks",
		schema: taskSchema,
		db,
		onError,
	});

	// Verify: Error handler was called
	expect(errorHandlerCalls).toHaveLength(1);
	expect(errorHandlerCalls[0].error).toMatchObject({
		code: "SQLITE_ERROR",
		fromVersion: 1,
		toVersion: 2,
	});

	// Verify: Recovery context has canResetSafely (no pending deltas)
	const context = errorHandlerCalls[0].context as {
		canResetSafely: boolean;
		pendingChanges: number;
	};
	expect(context.canResetSafely).toBe(true);
	expect(context.pendingChanges).toBe(0);

	// Verify: Result shows migration happened (via reset) with error
	expect(result.migrated).toBe(true);
	expect(result.error).toBeDefined();
	expect(result.error!.code).toBe("SQLITE_ERROR");

	// Verify: Schema version updated to target despite error (reset action)
	const storedVersion = await getStoredSchemaVersion(db, "tasks");
	expect(storedVersion).toBe(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Custom Migration
// ─────────────────────────────────────────────────────────────────────────────

test("migration_customMigration_receivesContextAndRuns", async () => {
	// Create versioned schema
	const taskSchema = define({
		version: 2,
		shape: v2Schema,
		defaults: { priority: "medium" },
		history: { 1: v1Schema },
	});

	// Create database at v1 with some documents
	const db = createTestDatabase();
	await createTestTable(db, "tasks", {
		id: "TEXT",
		title: "TEXT",
		completed: "INTEGER",
	});
	await setupDatabaseAtVersion(db, "tasks", 1);

	// Create kv table for custom migration marker
	await db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)`);

	db.clearSQLHistory();

	// Track custom migration calls
	let customMigrationCalled = false;
	let receivedContext: { dirtyDocs: unknown[]; diff: unknown } | null = null;

	const customMigration: ClientMigrationFn = async (database, ctx) => {
		customMigrationCalled = true;
		receivedContext = { dirtyDocs: ctx.dirtyDocs, diff: ctx.diff };

		// Set a marker to prove custom migration ran
		await database.run(`INSERT INTO kv (key, value) VALUES (?, ?)`, [
			"custom_migration_v2",
			"completed",
		]);

		// Run custom SQL instead of auto-generated
		await database.exec(`ALTER TABLE "tasks" ADD COLUMN "priority" TEXT DEFAULT 'custom'`);
	};

	// Run migrations with custom migration and document list
	const result = await runMigrations({
		collection: "tasks",
		schema: taskSchema,
		db,
		clientMigrations: { 2: customMigration },
		listDocuments: async () => ["doc-1", "doc-2", "doc-3"],
	});

	// Verify: Custom migration was called
	expect(customMigrationCalled).toBe(true);

	// Verify: Context had dirtyDocs with 3 entries
	expect(receivedContext).not.toBe(null);
	expect(receivedContext!.dirtyDocs).toHaveLength(3);
	expect((receivedContext!.dirtyDocs as Array<{ id: string }>).map(d => d.id)).toEqual([
		"doc-1",
		"doc-2",
		"doc-3",
	]);

	// Verify: Context had the schema diff
	expect(receivedContext!.diff).toMatchObject({
		fromVersion: 1,
		toVersion: 2,
	});

	// Verify: Marker was set (custom migration ran)
	const marker = await db.get<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [
		"custom_migration_v2",
	]);
	expect(marker?.value).toBe("completed");

	// Verify: Migration result
	expect(result.migrated).toBe(true);
	expect(result.fromVersion).toBe(1);
	expect(result.toVersion).toBe(2);

	// Verify: Table has priority column (from custom migration)
	const columns = db.getTableColumns("tasks");
	expect(columns).toContain("priority");

	// Verify: Auto-generated SQL was NOT in the executed SQL
	// (Custom migration used different DEFAULT value)
	const sqlStatements = db.getExecutedSQL();
	const autoGenSQL = sqlStatements.filter(sql => sql.includes("DEFAULT 'medium'"));
	expect(autoGenSQL).toHaveLength(0);
});
