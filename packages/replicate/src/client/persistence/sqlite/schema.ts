import * as Y from "yjs";
import type {
	Persistence,
	PersistenceProvider,
	KeyValueStore,
	MigrationDatabase,
} from "../types.js";

export interface Executor {
	execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	close(): void;
}

export async function initSchema(executor: Executor): Promise<void> {
	await executor.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      collection TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      state_vector BLOB,
      seq INTEGER DEFAULT 0
    )
  `);

	await executor.execute(`
    CREATE TABLE IF NOT EXISTS deltas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      data BLOB NOT NULL
    )
  `);

	await executor.execute(`
    CREATE INDEX IF NOT EXISTS deltas_collection_idx ON deltas (collection)
  `);

	await executor.execute(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

class SqliteKeyValueStore implements KeyValueStore {
	constructor(private executor: Executor) {}

	async get<T>(key: string): Promise<T | undefined> {
		const result = await this.executor.execute("SELECT value FROM kv WHERE key = ?", [key]);
		if (result.rows.length === 0) return undefined;
		return JSON.parse(result.rows[0].value as string) as T;
	}

	async set<T>(key: string, value: T): Promise<void> {
		await this.executor.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [
			key,
			JSON.stringify(value),
		]);
	}

	async del(key: string): Promise<void> {
		await this.executor.execute("DELETE FROM kv WHERE key = ?", [key]);
	}
}

/**
 * Adapter that wraps Executor to provide MigrationDatabase interface.
 */
class SqliteMigrationDatabase implements MigrationDatabase {
	constructor(private executor: Executor) {}

	async run(sql: string, params?: unknown[]): Promise<void> {
		await this.executor.execute(sql, params);
	}

	async exec(sql: string): Promise<void> {
		await this.executor.execute(sql);
	}

	async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
		const result = await this.executor.execute(sql, params);
		if (result.rows.length === 0) return undefined;
		return result.rows[0] as T;
	}

	async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const result = await this.executor.execute(sql, params);
		return result.rows as T[];
	}
}

class SqlitePersistenceProvider implements PersistenceProvider {
	private updateHandler: (update: Uint8Array, origin: unknown) => void;
	private pendingWrites: Promise<void>[] = [];
	private lastError: Error | null = null;
	readonly whenSynced: Promise<void>;

	constructor(
		private executor: Executor,
		private collection: string,
		private ydoc: Y.Doc,
		private onError?: (error: Error) => void,
	) {
		this.whenSynced = this.loadState();

		this.updateHandler = (update: Uint8Array, origin: unknown) => {
			if (origin !== "sqlite") {
				const writePromise = this.saveUpdate(update).catch((error: Error) => {
					this.lastError = error;
					this.onError?.(error);
				});
				this.pendingWrites.push(writePromise);
				writePromise.finally(() => {
					this.pendingWrites = this.pendingWrites.filter(p => p !== writePromise);
				});
			}
		};
		this.ydoc.on("update", this.updateHandler);
	}

	async flush(): Promise<void> {
		await Promise.all(this.pendingWrites);
		if (this.lastError) {
			const error = this.lastError;
			this.lastError = null;
			throw error;
		}
	}

	private async loadState(): Promise<void> {
		const snapshotResult = await this.executor.execute(
			"SELECT data FROM snapshots WHERE collection = ?",
			[this.collection],
		);

		if (snapshotResult.rows.length > 0) {
			const raw = snapshotResult.rows[0].data;
			const snapshotData = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
			Y.applyUpdate(this.ydoc, snapshotData, "sqlite");
		}

		const deltasResult = await this.executor.execute(
			"SELECT data FROM deltas WHERE collection = ? ORDER BY id ASC",
			[this.collection],
		);

		for (const row of deltasResult.rows) {
			const raw = row.data;
			const updateData = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
			Y.applyUpdate(this.ydoc, updateData, "sqlite");
		}
	}

	private async saveUpdate(update: Uint8Array): Promise<void> {
		await this.executor.execute("INSERT INTO deltas (collection, data) VALUES (?, ?)", [
			this.collection,
			update,
		]);
	}

	destroy(): void {
		this.ydoc.off("update", this.updateHandler);
	}
}

export function createPersistenceFromExecutor(executor: Executor): Persistence {
	return {
		createDocPersistence: (collection: string, ydoc: Y.Doc) =>
			new SqlitePersistenceProvider(executor, collection, ydoc),
		async listDocuments(prefix: string): Promise<string[]> {
			const result = await executor.execute(
				`SELECT DISTINCT collection FROM (
          SELECT collection FROM snapshots WHERE collection LIKE ?
          UNION
          SELECT collection FROM deltas WHERE collection LIKE ?
        )`,
				[`${prefix}:%`, `${prefix}:%`],
			);
			return result.rows.map(row => {
				const collection = row.collection as string;
				const parts = collection.split(":");
				return parts.slice(1).join(":");
			});
		},
		kv: new SqliteKeyValueStore(executor),
		db: new SqliteMigrationDatabase(executor),
	};
}
