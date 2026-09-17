import { createPersistenceFromExecutor, type Executor, type SqliteStatement } from './schema.js';
import type { Persistence } from '../types.js';
import { compileWasmModule, CDN_BASE } from './preload.js';

const INIT = 0;
const EXECUTE = 1;
const CLOSE = 2;
const TRANSACTION = 4;

interface Request {
	id: number;
	type: number;
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

type PendingRequest = {
	resolve: (rows: Record<string, unknown>[]) => void;
	reject: (error: Error) => void;
};

class WorkerExecutor implements Executor {
	private worker: Worker;
	private nextId = 0;
	private pending = new Map<number, PendingRequest>();
	private terminated = false;
	private closePromise: Promise<void> | null = null;

	constructor(worker: Worker) {
		this.worker = worker;
		this.worker.onmessage = (e: MessageEvent<Response>) => {
			const { id, ok, rows, error } = e.data;
			const handler = this.pending.get(id);
			if (!handler) return;
			this.pending.delete(id);

			if (ok) {
				handler.resolve(rows ?? []);
			} else {
				handler.reject(new Error(error ?? 'Unknown worker error'));
			}
		};

		// Handle worker errors - reject all pending requests
		this.worker.onerror = (event: ErrorEvent) => {
			const error = new Error(`Worker error: ${event.message || 'Unknown error'}`);
			this.rejectAllPending(error);
		};

		// Handle worker message errors
		this.worker.onmessageerror = () => {
			const error = new Error('Worker message deserialization failed');
			this.rejectAllPending(error);
		};
	}

	private rejectAllPending(error: Error): void {
		this.terminated = true;
		this.worker.terminate();
		for (const [, handler] of this.pending) {
			handler.reject(error);
		}
		this.pending.clear();
	}

	private send(type: number, payload: Partial<Request> = {}): Promise<Record<string, unknown>[]> {
		return new Promise((resolve, reject) => {
			if (this.terminated || (this.closePromise && type !== CLOSE)) {
				reject(new Error(this.terminated ? 'Worker has been terminated' : 'Worker is closing'));
				return;
			}
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			try {
				this.worker.postMessage({ id, type, ...payload } satisfies Request);
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	async init(name: string, wasmModule: WebAssembly.Module, assetBase: string): Promise<void> {
		await this.send(INIT, { name, wasmModule, assetBase });
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
		const rows = await this.send(EXECUTE, { sql, params });
		return { rows };
	}

	async transaction(statements: readonly SqliteStatement[]): Promise<void> {
		await this.send(TRANSACTION, { statements });
	}

	async close(): Promise<void> {
		if (this.terminated) return;
		if (!this.closePromise) {
			this.closePromise = this.send(CLOSE).then(
				() => {
					this.terminated = true;
					this.worker.terminate();
				},
				(error) => {
					this.terminated = true;
					this.worker.terminate();
					throw error;
				}
			);
		}
		await this.closePromise;
	}
}

export interface WebSqliteOptions {
	name: string;
	/** Base URL of a compatible wa-sqlite runtime graph, including dist/ and src/. */
	assetBase?: string;
	worker: Worker | (() => Worker | Promise<Worker>);
}

export async function createWebSqlitePersistence(options: WebSqliteOptions): Promise<Persistence> {
	const { name, worker } = options;
	const assetBase = new URL(options.assetBase ?? CDN_BASE, document.baseURI).href.replace(
		/\/$/,
		''
	);

	// Compile WASM in parallel with worker creation for maximum performance.
	// compileWasmModule() consumes the <link rel="preload"> cache entry and
	// uses WebAssembly.compileStreaming for streaming compilation.
	const [resolvedWorker, wasmModule] = await Promise.all([
		typeof worker === 'function' ? worker() : worker,
		compileWasmModule(assetBase),
	]);

	const executor = new WorkerExecutor(resolvedWorker);

	try {
		await executor.init(name, wasmModule, assetBase);
	} catch (error) {
		resolvedWorker.terminate();
		throw new Error(`Failed to initialize: ${error}`);
	}

	return createPersistenceFromExecutor(executor);
}

export function onceWebSqlitePersistence(options: WebSqliteOptions): () => Promise<Persistence> {
	let instance: Promise<Persistence> | null = null;
	return () => (instance ??= createWebSqlitePersistence(options));
}
