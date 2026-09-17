import { initSchema, type Executor, type SqliteStatement } from './schema.js';

const INIT = 0;
const EXECUTE = 1;
const CLOSE = 2;
const FLUSH = 3;
const TRANSACTION = 4;

interface Request {
	id: number;
	type: typeof INIT | typeof EXECUTE | typeof CLOSE | typeof FLUSH | typeof TRANSACTION;
	name?: string;
	wasmModule?: WebAssembly.Module;
	assetBase?: string;
	sql?: string;
	params?: unknown[];
	statements?: readonly SqliteStatement[];
}

interface Response {
	id: number;
	ok: boolean;
	rows?: Record<string, unknown>[];
	error?: string;
}

let sqlite3: any;
let db: number;
let vfs: any;
let mutex: Promise<unknown> = Promise.resolve();
let closing = false;
let closePromise: Promise<void> | null = null;

async function init(
	name: string,
	wasmModule: WebAssembly.Module,
	assetBase: string
): Promise<void> {
	const [{ default: SQLiteESMFactory }, { IDBBatchAtomicVFS }, SQLite] = await Promise.all([
		import(/* @vite-ignore */ `${assetBase}/dist/wa-sqlite-async.mjs`),
		import(/* @vite-ignore */ `${assetBase}/src/examples/IDBBatchAtomicVFS.js`),
		import(/* @vite-ignore */ `${assetBase}/src/sqlite-api.js`),
	]);

	const module = await SQLiteESMFactory({
		instantiateWasm(
			imports: WebAssembly.Imports,
			successCallback: (instance: WebAssembly.Instance) => void
		) {
			WebAssembly.instantiate(wasmModule, imports).then(successCallback);
			return {};
		},
	});
	sqlite3 = SQLite.Factory(module);

	vfs = await IDBBatchAtomicVFS.create(name, module);
	sqlite3.vfs_register(vfs, true);

	db = await sqlite3.open_v2(name);

	await sqlite3.exec(db, 'PRAGMA cache_size = -8000;');
	await sqlite3.exec(db, 'PRAGMA synchronous = FULL;');
	await sqlite3.exec(db, 'PRAGMA temp_store = MEMORY;');

	const executor: Executor = {
		async execute(sql, params) {
			return execute(sql, params);
		},
		close() {
			sqlite3.close(db);
			vfs.close();
		},
		transaction,
	};

	await initSchema(executor);
}

async function executeNow(
	sql: string,
	params?: unknown[]
): Promise<{ rows: Record<string, unknown>[] }> {
	const rows: Record<string, unknown>[] = [];

	for await (const stmt of sqlite3.statements(db, sql)) {
		if (params && params.length > 0) {
			sqlite3.bind_collection(stmt, params);
		}

		const columns: string[] = sqlite3.column_names(stmt);
		while ((await sqlite3.step(stmt)) === 100) {
			const row = sqlite3.row(stmt);
			const obj: Record<string, unknown> = {};
			columns.forEach((col: string, i: number) => {
				obj[col] = row[i];
			});
			rows.push(obj);
		}
	}

	return { rows };
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
	const result = mutex.catch(() => {}).then(operation);
	mutex = result;
	return result;
}

function execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
	return serialize(() => executeNow(sql, params));
}

function transaction(statements: readonly SqliteStatement[]): Promise<void> {
	return serialize(async () => {
		await executeNow('BEGIN IMMEDIATE');
		try {
			for (const statement of statements) await executeNow(statement.sql, statement.params);
			await executeNow('COMMIT');
		} catch (error) {
			try {
				await executeNow('ROLLBACK');
			} catch {
				// Preserve the statement failure that caused the rollback.
			}
			throw error;
		}
	});
}

self.onmessage = async (e: MessageEvent<Request>) => {
	const { id, type, name, sql, params } = e.data;

	try {
		switch (type) {
			case INIT:
				await init(name!, e.data.wasmModule!, e.data.assetBase!);
				self.postMessage({ id, ok: true } satisfies Response);
				break;
			case EXECUTE: {
				if (closing) throw new Error('SQLite worker is closing');
				const result = await execute(sql!, params);
				self.postMessage({ id, ok: true, rows: result.rows } satisfies Response);
				break;
			}
			case FLUSH:
				if (closing) throw new Error('SQLite worker is closing');
				await mutex;
				self.postMessage({ id, ok: true } satisfies Response);
				break;
			case TRANSACTION:
				if (closing) throw new Error('SQLite worker is closing');
				await transaction(e.data.statements!);
				self.postMessage({ id, ok: true } satisfies Response);
				break;
			case CLOSE:
				closing = true;
				closePromise ??= mutex
					.catch(() => {})
					.then(async () => {
						await sqlite3.close(db);
						await vfs.close();
					});
				await closePromise;
				self.postMessage({ id, ok: true } satisfies Response);
				break;
		}
	} catch (error) {
		self.postMessage({ id, ok: false, error: String(error) } satisfies Response);
	}
};
