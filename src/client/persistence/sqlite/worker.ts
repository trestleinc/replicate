import { initSchema, type Executor } from "./schema.js";

const CDN_BASE = "https://cdn.jsdelivr.net/gh/rhashimoto/wa-sqlite@master";

const INIT = 0;
const EXECUTE = 1;
const CLOSE = 2;

interface Request {
	id: number;
	type: typeof INIT | typeof EXECUTE | typeof CLOSE;
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

async function init(name: string): Promise<void> {
	const [{ default: SQLiteESMFactory }, { OPFSCoopSyncVFS }, SQLite] = await Promise.all([
		import(/* @vite-ignore */ `${CDN_BASE}/dist/wa-sqlite.mjs`),
		import(/* @vite-ignore */ `${CDN_BASE}/src/examples/OPFSCoopSyncVFS.js`),
		import(/* @vite-ignore */ `${CDN_BASE}/src/sqlite-api.js`),
	]);

	const module = await SQLiteESMFactory({
		locateFile: (file: string) => `${CDN_BASE}/dist/${file}`,
	});
	sqlite3 = SQLite.Factory(module);

	vfs = await OPFSCoopSyncVFS.create(name, module);
	sqlite3.vfs_register(vfs, true);

	db = await sqlite3.open_v2(name);

	await sqlite3.exec(db, "PRAGMA locking_mode = exclusive;");

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

async function execute(
	sql: string,
	params?: unknown[],
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
