import {
	initSchema,
	createPersistenceFromExecutor,
	type Executor,
	type SqliteStatement,
} from './schema.js';
import type { Persistence } from '../types.js';

interface OPSQLiteDatabase {
	execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	close(): void;
}

class OPSqliteExecutor implements Executor {
	private tail: Promise<unknown> = Promise.resolve();
	private closing = false;
	private closePromise: Promise<void> | null = null;

	constructor(private db: OPSQLiteDatabase) {}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new Error('SQLite database is closing'));
		const result = this.tail.catch(() => {}).then(operation);
		this.tail = result;
		return result;
	}

	execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
		return this.enqueue(async () => {
			const result = await this.db.execute(sql, params);
			return { rows: result.rows || [] };
		});
	}

	transaction(statements: readonly SqliteStatement[]): Promise<void> {
		return this.enqueue(async () => {
			await this.db.execute('BEGIN IMMEDIATE');
			try {
				for (const statement of statements) {
					await this.db.execute(statement.sql, statement.params);
				}
				await this.db.execute('COMMIT');
			} catch (error) {
				try {
					await this.db.execute('ROLLBACK');
				} catch {
					// Preserve the statement failure that caused the rollback.
				}
				throw error;
			}
		});
	}

	async close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.tail.catch(() => {}).then(() => this.db.close());
			this.tail = this.closePromise;
		}
		await this.closePromise;
	}
}

export async function createNativeSqlitePersistence(
	db: OPSQLiteDatabase,
	_dbName: string
): Promise<Persistence> {
	const executor = new OPSqliteExecutor(db);
	await initSchema(executor);
	return createPersistenceFromExecutor(executor);
}
