/**
 * In-memory SQLite-like database for migration tests.
 * Tracks executed SQL and simulates table structure.
 */

import type { MigrationDatabase } from "$/client/persistence/types";

interface TableSchema {
	columns: Map<string, string>; // column name -> type
	rows: Map<string, Record<string, unknown>>[]; // array of rows
}

/**
 * Test database that tracks SQL execution and simulates SQLite behavior.
 */
export interface TestDatabase extends MigrationDatabase {
	/** Get all SQL statements executed */
	getExecutedSQL(): string[];
	/** Get columns for a table */
	getTableColumns(table: string): string[];
	/** Check if table exists */
	hasTable(table: string): boolean;
	/** Get all rows from a table */
	getRows<T>(table: string): T[];
	/** Clear all executed SQL tracking */
	clearSQLHistory(): void;
	/** Inject an error to be thrown on next exec/run */
	injectError(error: Error): void;
}

/**
 * Create an in-memory test database.
 */
export function createTestDatabase(): TestDatabase {
	const tables = new Map<string, TableSchema>();
	const executedSQL: string[] = [];
	let injectedError: Error | null = null;

	function parseCreateTable(sql: string): { name: string; columns: Map<string, string> } | null {
		const match = sql.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?\s*\(([\s\S]+)\)/i);
		if (!match) return null;

		const name = match[1];
		const columns = new Map<string, string>();
		const columnDefs = match[2].split(",");

		for (const def of columnDefs) {
			const colMatch = def.trim().match(/^"?(\w+)"?\s+(\w+)/);
			if (colMatch) {
				columns.set(colMatch[1], colMatch[2]);
			}
		}

		return { name, columns };
	}

	function parseAlterTable(
		sql: string,
	): { table: string; action: "add" | "drop"; column: string; type?: string } | null {
		const addMatch = sql.match(
			/ALTER TABLE\s+"?(\w+)"?\s+ADD COLUMN\s+"?(\w+)"?\s+(\w+)(?:\s+DEFAULT\s+(.+))?/i,
		);
		if (addMatch) {
			return { table: addMatch[1], action: "add", column: addMatch[2], type: addMatch[3] };
		}

		const dropMatch = sql.match(/ALTER TABLE\s+"?(\w+)"?\s+DROP COLUMN\s+"?(\w+)"?/i);
		if (dropMatch) {
			return { table: dropMatch[1], action: "drop", column: dropMatch[2] };
		}

		return null;
	}

	function parseInsert(
		sql: string,
		params: unknown[] = [],
	): { table: string; row: Record<string, unknown>; replace: boolean; keyColumn?: string } | null {
		const replaceMatch = sql.match(/INSERT\s+OR\s+REPLACE/i);
		const match = sql.match(
			/INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+"?(\w+)"?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
		);
		if (!match) return null;

		const table = match[1];
		const columns = match[2].split(",").map(c => c.trim().replace(/"/g, ""));
		const row: Record<string, unknown> = {};

		columns.forEach((col, i) => {
			row[col] = params[i];
		});

		// For INSERT OR REPLACE, first column is typically the primary key
		return { table, row, replace: !!replaceMatch, keyColumn: columns[0] };
	}

	function parseSelect(
		sql: string,
		params: unknown[] = [],
	): { table: string; where?: { column: string; value: unknown } } | null {
		const match = sql.match(/SELECT\s+.+\s+FROM\s+"?(\w+)"?(?:\s+WHERE\s+(\w+)\s*=\s*\?)?/i);
		if (!match) return null;

		const result: { table: string; where?: { column: string; value: unknown } } = {
			table: match[1],
		};

		if (match[2] && params.length > 0) {
			result.where = { column: match[2], value: params[0] };
		}

		return result;
	}

	function parseDelete(
		sql: string,
		params: unknown[] = [],
	): { table: string; where?: { column: string; value: unknown } } | null {
		const match = sql.match(/DELETE\s+FROM\s+"?(\w+)"?(?:\s+WHERE\s+(\w+)\s+LIKE\s+\?)?/i);
		if (!match) return null;

		return {
			table: match[1],
			where: match[2] ? { column: match[2], value: params[0] } : undefined,
		};
	}

	const db: TestDatabase = {
		async run(sql: string, params: unknown[] = []): Promise<void> {
			executedSQL.push(sql);

			if (injectedError) {
				const err = injectedError;
				injectedError = null;
				throw err;
			}

			// Handle INSERT (and INSERT OR REPLACE)
			const insert = parseInsert(sql, params);
			if (insert) {
				const table = tables.get(insert.table);
				if (table) {
					if (insert.replace && insert.keyColumn) {
						// Remove existing row with same key before inserting
						const keyValue = insert.row[insert.keyColumn];
						const existingIndex = table.rows.findIndex(
							r => (r as Record<string, unknown>)[insert.keyColumn!] === keyValue,
						);
						if (existingIndex >= 0) {
							table.rows.splice(existingIndex, 1);
						}
					}
					table.rows.push(insert.row as never);
				}
				return;
			}

			// Handle DELETE
			const del = parseDelete(sql, params);
			if (del) {
				const table = tables.get(del.table);
				if (table && del.where) {
					const pattern = String(del.where.value).replace(/%/g, ".*");
					const regex = new RegExp(`^${pattern}$`);
					table.rows = table.rows.filter(row => {
						const val = String((row as Record<string, unknown>)[del.where!.column] ?? "");
						return !regex.test(val);
					});
				}
				return;
			}
		},

		async exec(sql: string): Promise<void> {
			executedSQL.push(sql);

			if (injectedError) {
				const err = injectedError;
				injectedError = null;
				throw err;
			}

			// Handle CREATE TABLE
			const create = parseCreateTable(sql);
			if (create) {
				if (!tables.has(create.name)) {
					tables.set(create.name, { columns: create.columns, rows: [] });
				}
				return;
			}

			// Handle ALTER TABLE
			const alter = parseAlterTable(sql);
			if (alter) {
				const table = tables.get(alter.table);
				if (!table) {
					throw new Error(`Table ${alter.table} does not exist`);
				}
				if (alter.action === "add") {
					table.columns.set(alter.column, alter.type ?? "TEXT");
				} else if (alter.action === "drop") {
					table.columns.delete(alter.column);
				}
				return;
			}
		},

		async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
			executedSQL.push(sql);

			const select = parseSelect(sql, params);
			if (!select) return undefined;

			const table = tables.get(select.table);
			if (!table) return undefined;

			if (select.where) {
				const row = table.rows.find(
					r => (r as Record<string, unknown>)[select.where!.column] === select.where!.value,
				);
				return row as T | undefined;
			}

			return table.rows[0] as T | undefined;
		},

		async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
			executedSQL.push(sql);

			const select = parseSelect(sql, params);
			if (!select) return [];

			const table = tables.get(select.table);
			if (!table) return [];

			if (select.where) {
				return table.rows.filter(
					r => (r as Record<string, unknown>)[select.where!.column] === select.where!.value,
				) as T[];
			}

			return table.rows as T[];
		},

		getExecutedSQL(): string[] {
			return [...executedSQL];
		},

		getTableColumns(tableName: string): string[] {
			const table = tables.get(tableName);
			return table ? Array.from(table.columns.keys()) : [];
		},

		hasTable(tableName: string): boolean {
			return tables.has(tableName);
		},

		getRows<T>(tableName: string): T[] {
			const table = tables.get(tableName);
			return table ? (table.rows as T[]) : [];
		},

		clearSQLHistory(): void {
			executedSQL.length = 0;
		},

		injectError(error: Error): void {
			injectedError = error;
		},
	};

	return db;
}

/**
 * Set up a test database with schema table at a specific version.
 */
export async function setupDatabaseAtVersion(
	db: TestDatabase,
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
 * Create a table with specified columns for testing.
 */
export async function createTestTable(
	db: TestDatabase,
	tableName: string,
	columns: Record<string, string>,
): Promise<void> {
	const columnDefs = Object.entries(columns)
		.map(([name, type]) => `"${name}" ${type}`)
		.join(", ");
	await db.exec(`CREATE TABLE "${tableName}" (${columnDefs})`);
}
