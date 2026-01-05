import { initSchema, type Executor } from "./schema.js";

const CDN_BASE = "https://wa-sqlite.robelest.com/v1.0.0";

const INIT = 0;
const EXECUTE = 1;
const CLOSE = 2;
const FLUSH = 3;

interface Request {
	id: number;
	type: typeof INIT | typeof EXECUTE | typeof CLOSE | typeof FLUSH;
	name?: string;
	sql?: string;
	params?: unknown[];
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

async function init(name: string): Promise<void> {
	const [{ default: SQLiteESMFactory }, { IDBBatchAtomicVFS }, SQLite] = await Promise.all([
		import(/* @vite-ignore */ `${CDN_BASE}/dist/wa-sqlite-async.mjs`),
		import(/* @vite-ignore */ `${CDN_BASE}/src/examples/IDBBatchAtomicVFS.js`),
		import(/* @vite-ignore */ `${CDN_BASE}/src/sqlite-api.js`),
	]);

	const module = await SQLiteESMFactory({
		locateFile: (file: string) => `${CDN_BASE}/dist/${file}`,
	});
	sqlite3 = SQLite.Factory(module);

	vfs = await IDBBatchAtomicVFS.create(name, module);
	sqlite3.vfs_register(vfs, true);

	db = await sqlite3.open_v2(name);

	await sqlite3.exec(db, "PRAGMA cache_size = -8000;");
	await sqlite3.exec(db, "PRAGMA synchronous = NORMAL;");
	await sqlite3.exec(db, "PRAGMA temp_store = MEMORY;");

	const executor: Executor = {
		async execute(sql, params) {
			return execute(sql, params);
		},
		close() {
			sqlite3.close(db);
			vfs.close();
		},
	};

	await initSchema(executor);
}

function execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
	const operation = mutex
		.catch(() => {})
		.then(async () => {
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
		});

	mutex = operation;
	return operation;
}

self.onmessage = async (e: MessageEvent<Request>) => {
	const { id, type, name, sql, params } = e.data;

	try {
		switch (type) {
			case INIT:
				await init(name!);
				self.postMessage({ id, ok: true } satisfies Response);
				break;
			case EXECUTE:
				const result = await execute(sql!, params);
				self.postMessage({ id, ok: true, rows: result.rows } satisfies Response);
				break;
			case FLUSH:
				self.postMessage({ id, ok: true } satisfies Response);
				break;
			case CLOSE:
				sqlite3.close(db);
				vfs.close();
				self.postMessage({ id, ok: true } satisfies Response);
				break;
		}
	} catch (error) {
		self.postMessage({ id, ok: false, error: String(error) } satisfies Response);
	}
};
