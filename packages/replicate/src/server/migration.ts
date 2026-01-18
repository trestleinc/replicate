/**
 * Migration System - Versioned Schemas with Auto-Diff
 *
 * Provides zero mental overhead migrations for local-first apps.
 * Users define versioned schemas, write server migrations,
 * and client migrations are generated automatically.
 */

import type { GenericValidator, Infer } from "convex/values";
import type { GenericMutationCtx, GenericDataModel } from "convex/server";

// ─────────────────────────────────────────────────────────────────────────────
// Schema Diff Types
// ─────────────────────────────────────────────────────────────────────────────

/** Field type for schema operations */
export type FieldType = "string" | "number" | "boolean" | "null" | "array" | "object" | "prose";

/** Individual diff operation detected between schema versions */
export type SchemaDiffOperation =
	| { type: "add_column"; column: string; fieldType: FieldType; defaultValue: unknown }
	| { type: "remove_column"; column: string }
	| { type: "rename_column"; from: string; to: string }
	| { type: "change_type"; column: string; from: FieldType; to: FieldType };

/** Result of diffing two schema versions */
export interface SchemaDiff {
	fromVersion: number;
	toVersion: number;
	operations: SchemaDiffOperation[];
	isBackwardsCompatible: boolean;
	generatedSQL: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Types
// ─────────────────────────────────────────────────────────────────────────────

/** Context passed to server migration functions */
export interface MigrationContext<DataModel extends GenericDataModel = GenericDataModel> {
	db: GenericMutationCtx<DataModel>["db"];
}

/** Single migration definition */
export interface MigrationDefinition<T = unknown> {
	name: string;
	batchSize?: number;
	parallelize?: boolean;
	migrate: (ctx: MigrationContext, doc: T) => Promise<void>;
}

/** Map of version numbers to migration definitions */
export type MigrationMap<T = unknown> = Record<number, MigrationDefinition<T>>;

// ─────────────────────────────────────────────────────────────────────────────
// Versioned Schema Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options for schema.define() */
export interface SchemaDefinitionOptions<TShape extends GenericValidator> {
	/** Current schema version (increment when schema changes) */
	version: number;
	/** Convex validator for the document shape */
	shape: TShape;
	/** Default values for optional fields (applied during migrations) */
	defaults?: Partial<Infer<TShape>>;
	/** Previous schema versions for diffing */
	history?: Record<number, GenericValidator>;
}

/** Versioned schema with migration capabilities */
export interface VersionedSchema<TShape extends GenericValidator> {
	/** Current schema version */
	readonly version: number;
	/** Convex validator for the document shape */
	readonly shape: TShape;
	/** Default values for optional fields */
	readonly defaults: Partial<Infer<TShape>>;
	/** Previous schema versions */
	readonly history: Record<number, GenericValidator>;

	/** Get validator for a specific version */
	getVersion(version: number): GenericValidator;

	/** Compute diff between two versions */
	diff(fromVersion: number, toVersion: number): SchemaDiff;

	/** Define server migrations for this schema */
	migrations(definitions: MigrationMap<Infer<TShape>>): SchemaMigrations<TShape>;
}

/** Schema migrations wrapper */
export interface SchemaMigrations<TShape extends GenericValidator> {
	/** The versioned schema */
	readonly schema: VersionedSchema<TShape>;
	/** Migration definitions by version */
	readonly definitions: MigrationMap<Infer<TShape>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Diff Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect field type from a Convex validator.
 * This uses the validator's internal structure to determine the type.
 */
function detectFieldType(validator: GenericValidator): FieldType {
	const v = validator as { kind?: string; type?: string };

	// Check for prose validator (has specific structure)
	if (v.kind === "object") {
		const inner = (validator as { fields?: Record<string, unknown> }).fields;
		if (inner && "type" in inner && "content" in inner) {
			return "prose";
		}
		return "object";
	}

	switch (v.kind) {
		case "string":
			return "string";
		case "number":
		case "float64":
		case "int64":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return "array";
		case "object":
			return "object";
		default:
			return "object";
	}
}

/**
 * Extract field names from a Convex object validator.
 */
function extractFields(validator: GenericValidator): Map<string, GenericValidator> {
	const fields = new Map<string, GenericValidator>();
	const v = validator as { kind?: string; fields?: Record<string, GenericValidator> };

	if (v.kind === "object" && v.fields) {
		for (const [name, fieldValidator] of Object.entries(v.fields)) {
			fields.set(name, fieldValidator);
		}
	}

	return fields;
}

/**
 * Map field type to SQLite type.
 */
function fieldTypeToSQL(fieldType: FieldType): string {
	switch (fieldType) {
		case "string":
		case "prose":
			return "TEXT";
		case "number":
			return "REAL";
		case "boolean":
			return "INTEGER";
		case "null":
			return "TEXT";
		case "array":
		case "object":
			return "TEXT"; // JSON stored as text
		default:
			return "TEXT";
	}
}

/**
 * Escape SQL literal value.
 */
function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

/**
 * Validate SQL identifier to prevent injection.
 */
function validateIdentifier(name: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		throw new Error(`Invalid SQL identifier: "${name}"`);
	}
	return `"${name}"`;
}

/**
 * Compute the diff between two schema versions.
 */
function computeSchemaDiff(
	fromValidator: GenericValidator,
	toValidator: GenericValidator,
	fromVersion: number,
	toVersion: number,
	defaults: Record<string, unknown>,
): SchemaDiff {
	const operations: SchemaDiffOperation[] = [];
	const generatedSQL: string[] = [];

	const fromFields = extractFields(fromValidator);
	const toFields = extractFields(toValidator);

	// Detect added fields
	for (const [name, validator] of toFields) {
		if (!fromFields.has(name)) {
			const fieldType = detectFieldType(validator);
			const defaultValue = defaults[name];

			operations.push({
				type: "add_column",
				column: name,
				fieldType,
				defaultValue,
			});

			const sqlType = fieldTypeToSQL(fieldType);
			const colName = validateIdentifier(name);
			const def = defaultValue !== undefined ? ` DEFAULT ${sqlLiteral(defaultValue)}` : "";
			generatedSQL.push(`ALTER TABLE %TABLE% ADD COLUMN ${colName} ${sqlType}${def}`);
		}
	}

	// Detect removed fields
	for (const [name] of fromFields) {
		if (!toFields.has(name)) {
			operations.push({
				type: "remove_column",
				column: name,
			});

			const colName = validateIdentifier(name);
			generatedSQL.push(`ALTER TABLE %TABLE% DROP COLUMN ${colName}`);
		}
	}

	// Detect type changes (simplified - compares field types)
	for (const [name, toFieldValidator] of toFields) {
		const fromFieldValidator = fromFields.get(name);
		if (fromFieldValidator) {
			const fromType = detectFieldType(fromFieldValidator);
			const toType = detectFieldType(toFieldValidator);
			if (fromType !== toType) {
				operations.push({
					type: "change_type",
					column: name,
					from: fromType,
					to: toType,
				});
				// Type changes require custom migration
			}
		}
	}

	// Backwards compatible if only adding optional columns with defaults
	const isBackwardsCompatible = operations.every(op => {
		if (op.type === "add_column") {
			return op.defaultValue !== undefined;
		}
		return false;
	});

	return {
		fromVersion,
		toVersion,
		operations,
		isBackwardsCompatible,
		generatedSQL,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// schema.define() Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Define a versioned schema with migration capabilities.
 *
 * @example
 * ```typescript
 * import { schema } from "@trestleinc/replicate/server";
 * import { v } from "convex/values";
 *
 * export const taskSchema = schema.define({
 *   version: 2,
 *   shape: v.object({
 *     id: v.string(),
 *     title: v.string(),
 *     priority: v.optional(v.string()),
 *     content: schema.prose(),
 *   }),
 *   defaults: {
 *     priority: "medium",
 *   },
 *   history: {
 *     1: v.object({
 *       id: v.string(),
 *       title: v.string(),
 *       content: schema.prose(),
 *     }),
 *   },
 * });
 * ```
 */
export function define<TShape extends GenericValidator>(
	options: SchemaDefinitionOptions<TShape>,
): VersionedSchema<TShape> {
	const { version, shape, defaults = {}, history = {} } = options;

	// Store current version in history
	const allVersions: Record<number, GenericValidator> = {
		...history,
		[version]: shape,
	};

	const versionedSchema: VersionedSchema<TShape> = {
		version,
		shape,
		defaults: defaults as Partial<Infer<TShape>>,
		history: allVersions,

		getVersion(v: number): GenericValidator {
			const validator = allVersions[v];
			if (!validator) {
				throw new Error(
					`Schema version ${v} not found. Available: ${Object.keys(allVersions).join(", ")}`,
				);
			}
			return validator;
		},

		diff(fromVersion: number, toVersion: number): SchemaDiff {
			const fromValidator = this.getVersion(fromVersion);
			const toValidator = this.getVersion(toVersion);
			return computeSchemaDiff(
				fromValidator,
				toValidator,
				fromVersion,
				toVersion,
				defaults as Record<string, unknown>,
			);
		},

		migrations(definitions: MigrationMap<Infer<TShape>>): SchemaMigrations<TShape> {
			return {
				schema: versionedSchema,
				definitions,
			};
		},
	};

	return versionedSchema;
}
