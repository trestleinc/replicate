import { initSchema, createPersistenceFromExecutor, type Executor } from "./schema.js";
import type { Persistence } from "../types.js";

interface OPSQLiteDatabase {
	execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	close(): void;
}

class OPSqliteExecutor implements Executor {
	constructor(private db: OPSQLiteDatabase) {}

	async execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
		const result = await this.db.execute(sql, params);
		return { rows: result.rows || [] };
	}

	close(): void {
		this.db.close();
	}
}

export async function createNativeSqlitePersistence(
	db: OPSQLiteDatabase,
	_dbName: string,
): Promise<Persistence> {
	const executor = new OPSqliteExecutor(db);
	await initSchema(executor);
	return createPersistenceFromExecutor(executor);
}
