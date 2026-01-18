import { createPersistenceFromExecutor, type Executor } from "./schema.js";
import type { Persistence } from "../types.js";

const INIT = 0;
const EXECUTE = 1;
const CLOSE = 2;

interface Request {
	id: number;
	type: number;
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

type PendingRequest = {
	resolve: (rows: Record<string, unknown>[]) => void;
	reject: (error: Error) => void;
};

class WorkerExecutor implements Executor {
	private worker: Worker;
	private nextId = 0;
	private pending = new Map<number, PendingRequest>();
	private terminated = false;

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
				handler.reject(new Error(error ?? "Unknown worker error"));
			}
		};

		// Handle worker errors - reject all pending requests
		this.worker.onerror = (event: ErrorEvent) => {
			const error = new Error(`Worker error: ${event.message || "Unknown error"}`);
			this.rejectAllPending(error);
		};

		// Handle worker message errors
		this.worker.onmessageerror = () => {
			const error = new Error("Worker message deserialization failed");
			this.rejectAllPending(error);
		};
	}

	private rejectAllPending(error: Error): void {
		this.terminated = true;
		for (const [, handler] of this.pending) {
			handler.reject(error);
		}
		this.pending.clear();
	}

	private send(type: number, payload: Partial<Request> = {}): Promise<Record<string, unknown>[]> {
		return new Promise((resolve, reject) => {
			if (this.terminated) {
				reject(new Error("Worker has been terminated"));
				return;
			}
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({ id, type, ...payload } satisfies Request);
		});
	}

	async init(name: string): Promise<void> {
		await this.send(INIT, { name });
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
		const rows = await this.send(EXECUTE, { sql, params });
		return { rows };
	}

	close(): void {
		for (const [, handler] of this.pending) {
			handler.reject(new Error("Worker terminated"));
		}
		this.pending.clear();
		this.send(CLOSE).catch(() => {});
		this.worker.terminate();
	}
}

export interface WebSqliteOptions {
	name: string;
	worker: Worker | (() => Worker | Promise<Worker>);
}

export async function createWebSqlitePersistence(options: WebSqliteOptions): Promise<Persistence> {
	const { name, worker } = options;

	const resolvedWorker = typeof worker === "function" ? await worker() : worker;
	const executor = new WorkerExecutor(resolvedWorker);

	try {
		await executor.init(name);
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
