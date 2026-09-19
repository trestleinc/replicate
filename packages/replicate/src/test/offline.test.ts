// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import { v } from 'convex/values';
import { collection } from '../client/collection';
import { schema } from '../server';
import { createNativeSqlitePersistence } from '../client/persistence/sqlite/native';
import { createCustomPersistence } from '../client/persistence/custom';
import { createWebEncryptionPersistence } from '../client/persistence/encrypted/web';
import { createConnection } from '../client/services/connection';
import type { ConnectionOptions } from '../client/services/connection';
import type { Persistence } from '../client/persistence/types';

const api = Object.fromEntries(
	['material', 'delta', 'replicate', 'presence', 'session'].map((name) => [
		name,
		makeFunctionReference(`offline:${name}`),
	])
) as any;
const definition = schema.define({
	shape: v.object({ id: v.string(), title: v.string(), note: v.optional(v.string()) }),
	defaults: {},
	history: {},
});
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});
const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
function transport() {
	const subscriptions: { args: any; callback: (value: any) => void; stopped: boolean }[] = [];
	const client = {
		query: vi.fn(async () => ({ mode: 'recovery', exists: true, diff: null }) as any),
		mutation: vi.fn(async () => ({ success: true, seq: 1 })),
		onUpdate: vi.fn((_ref: any, args: any, callback: (value: any) => void) => {
			const sub = { args, callback, stopped: false };
			subscriptions.push(sub);
			return () => {
				if (sub.stopped) throw new Error('Subscription already stopped');
				sub.stopped = true;
			};
		}),
	};
	return {
		client,
		subscriptions,
		emit: (value: any) =>
			subscriptions.filter((s) => !s.stopped && 'seq' in s.args).forEach((s) => s.callback(value)),
	};
}
async function disk(path?: string, before?: (sql: string, params?: unknown[]) => Promise<void>) {
	if (!path) {
		const directory = await mkdtemp(join(tmpdir(), 'replicate-contract-'));
		disposals.push(() => rm(directory, { recursive: true, force: true }));
		path = join(directory, 'replica.sqlite');
	}
	const db = new DatabaseSync(path);
	let closed = false;
	const persistence = await createNativeSqlitePersistence(
		{
			async execute(sql, params = []) {
				await before?.(sql, params);
				const statement = db.prepare(sql);
				if (statement.columns().length)
					return { rows: statement.all(...(params as any[])) as Record<string, unknown>[] };
				statement.run(...(params as any[]));
				return { rows: [] };
			},
			close() {
				closed = true;
				db.close();
			},
		},
		path
	);
	return { persistence, path, database: db, isClosed: () => closed };
}
async function seed(p: Persistence, id = 'a') {
	const doc = new Y.Doc();
	doc.clientID = 1;
	const provider = p.createDocPersistence(`offline:${id}`, doc);
	await provider.whenSynced;
	doc.getMap('fields').set('title', 'persisted');
	await provider.flush!();
	provider.destroy();
	doc.destroy();
}
async function open(p: Persistence, network = transport(), options: ConnectionOptions = {}) {
	const lazy = collection.create<{ id: string; title: string }>({
		schema: definition,
		persistence: async () => p,
		config: () => ({ convexClient: network.client as any, api, getKey: (row) => row.id }),
		...options,
	});
	await lazy.init();
	const rows = lazy.get();
	await rows.preload();
	disposals.push(async () => {
		await rows.disconnect();
		await rows.cleanup();
	});
	return { rows, network };
}
function change(id: string, seq: number, title = 'remote') {
	const doc = new Y.Doc();
	doc.clientID = 2;
	doc.getMap('fields').set('title', title);
	const bytes = Y.encodeStateAsUpdateV2(doc).buffer;
	doc.destroy();
	return { document: id, seq, bytes, type: 'delta', exists: true };
}
const page = (...changes: any[]) => ({
	mode: 'stream',
	changes,
	seq: changes.at(-1).seq,
	more: false,
});

test.each(['disconnect', 'reset'] as const)(
	'%s followed by reconnect and cleanup stops each transport subscription once',
	async (action) => {
		const db = await disk();
		disposals.push(() => db.persistence.close!());
		const { rows, network } = await open(db.persistence, transport(), { networkMode: 'manual' });
		await rows.connect();
		const first = [...network.subscriptions];
		expect(first.length).toBeGreaterThan(0);
		await rows[action]();
		expect(first.every((sub) => sub.stopped)).toBe(true);
		await rows.connect();
		expect(network.subscriptions.some((sub) => !sub.stopped)).toBe(true);
		await rows.disconnect();
		await rows.cleanup();
		expect(network.subscriptions.every((sub) => sub.stopped)).toBe(true);
	}
);

test('unsubscribing suppresses queued callbacks without disconnecting other subscriptions', () => {
	const callbacks: { value: (value: unknown) => void; error: (error: Error) => void }[] = [];
	const stop = vi.fn();
	const connection = createConnection(
		{
			onUpdate: (_ref: unknown, _args: unknown, value: any, error: any) => {
				callbacks.push({ value, error });
				return stop;
			},
		} as any,
		{}
	);
	connection.connect();
	const value = vi.fn();
	const error = vi.fn();
	const remaining = vi.fn();
	const unsubscribe = connection.client.onUpdate(api.delta, {}, value, error);
	connection.client.onUpdate(api.delta, {}, remaining);
	unsubscribe();
	unsubscribe();
	callbacks[0].value({});
	callbacks[0].error(new Error('queued'));
	callbacks[1].value({});
	expect(value).not.toHaveBeenCalled();
	expect(error).not.toHaveBeenCalled();
	expect(remaining).toHaveBeenCalledOnce();
	expect(stop).toHaveBeenCalledOnce();
	connection.disconnect();
	expect(stop).toHaveBeenCalledTimes(2);
});

test('manual session subscribers start on connect and reject old callbacks after reconnect', async () => {
	const first = await disk();
	disposals.push(() => first.persistence.close!());
	const net = transport();
	const { rows } = await open(first.persistence, net, { networkMode: 'manual' });
	const listener = vi.fn();
	const stop = rows.session.subscribe(listener);
	expect(net.client.onUpdate).not.toHaveBeenCalled();
	await rows.connect();
	const original = net.subscriptions.find((sub) => sub.args.connected === true)!;
	expect(original).toBeDefined();
	listener.mockClear();
	original.callback([]);
	expect(listener).toHaveBeenCalledOnce();
	await rows.disconnect();
	await rows.connect();
	listener.mockClear();
	original.callback([]);
	expect(listener).not.toHaveBeenCalled();
	const current = net.subscriptions.find((sub) => sub.args.connected === true && !sub.stopped)!;
	expect(current).not.toBe(original);
	current.callback([]);
	expect(listener).toHaveBeenCalledOnce();
	stop();
});

test.each(['insert', 'recovery'])(
	'reset drains accepted %s pending-marker deletion',
	async (source) => {
		const first = await disk();
		disposals.push(() => first.persistence.close!());
		if (source === 'recovery') {
			await seed(first.persistence);
			await first.persistence.kv.set('pending-create:offline:a', true);
		}
		const entered = deferred();
		const release = deferred();
		const del = first.persistence.kv.del.bind(first.persistence.kv);
		let intercept = true;
		first.persistence.kv.del = async (key) => {
			if (intercept && key === 'pending-create:offline:a') {
				intercept = false;
				entered.resolve();
				await release.promise;
			}
			await del(key);
		};
		const { rows } = await open(first.persistence);
		if (source === 'insert') {
			void rows.insert({ id: 'a', title: 'old' }).isPersisted.promise.catch(() => {});
		}
		await entered.promise;
		let resetDone = false;
		const reset = rows.reset().then(() => {
			resetDone = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		const completedBeforeRelease = resetDone;
		release.resolve();
		await reset;
		expect(completedBeforeRelease).toBe(false);
		expect(await first.persistence.kv.get('pending-create:offline:a')).toBeUndefined();
	}
);

test('recovery and single-document stream changes preserve untouched row identities', async () => {
	const first = await disk();
	disposals.push(() => first.persistence.close!());
	await seed(first.persistence, 'a');
	await seed(first.persistence, 'b');
	const { rows, network } = await open(first.persistence, transport(), { networkMode: 'manual' });
	const originalA = rows.get('a');
	const originalB = rows.get('b');
	await rows.connect();
	await vi.waitFor(() => expect(network.client.query).toHaveBeenCalledTimes(2));
	await rows.disconnect();
	expect(rows.get('a')).toBe(originalA);
	expect(rows.get('b')).toBe(originalB);
	await rows.connect();
	network.emit(page(change('a', 1, 'changed')));
	await vi.waitFor(() => expect(rows.get('a')?.title).toBe('changed'));
	expect(rows.get('b')).toBe(originalB);
});

test('targeted stream publication removes fields missing from the current document', async () => {
	const first = await disk();
	disposals.push(() => first.persistence.close!());
	const { rows, network } = await open(first.persistence, transport(), { networkMode: 'manual' });
	await rows.connect();
	const remote = new Y.Doc();
	remote.getMap('fields').set('title', 'record');
	remote.getMap('fields').set('note', 'removed later');
	network.emit(page({ ...change('a', 1), bytes: Y.encodeStateAsUpdateV2(remote).buffer }));
	await vi.waitFor(() => expect(rows.get('a')).toHaveProperty('note', 'removed later'));
	const vector = Y.encodeStateVector(remote);
	remote.getMap('fields').delete('note');
	network.emit(page({ ...change('a', 2), bytes: Y.encodeStateAsUpdateV2(remote, vector).buffer }));
	await vi.waitFor(() => expect(rows.get('a')).not.toHaveProperty('note'));
	expect(rows.get('a')?.title).toBe('record');
	remote.destroy();
});

test('recovery and streaming flush only the documents whose data changed', async () => {
	const first = await disk();
	disposals.push(() => first.persistence.close!());
	const count = 20;
	for (let id = 0; id < count; id++) await seed(first.persistence, String(id));
	let flushes = 0;
	const create = first.persistence.createDocPersistence.bind(first.persistence);
	first.persistence.createDocPersistence = (key, doc) => {
		const provider = create(key, doc);
		const flush = provider.flush!.bind(provider);
		provider.flush = async () => {
			flushes++;
			await flush();
		};
		return provider;
	};
	const network = transport();
	network.client.query.mockResolvedValue({
		mode: 'recovery',
		exists: true,
		diff: change('unused', 1).bytes,
	});
	const { rows } = await open(first.persistence, network, {
		networkMode: 'manual',
		readOnly: true,
	});
	await rows.connect();
	await vi.waitFor(() =>
		expect([...rows.values()].filter((row) => row.title === 'remote')).toHaveLength(count)
	);
	expect(flushes).toBeLessThanOrEqual(count * 2);
	flushes = 0;
	network.emit(page(change('new', 1)));
	await vi.waitFor(() => expect(rows.get('new')?.title).toBe('remote'));
	expect(flushes).toBeLessThanOrEqual(2);
});

test.each(['data', 'cursor'])(
	'disconnect during %s persistence keeps durable rows readable on offline reconnect',
	async (phase) => {
		const entered = deferred();
		const release = deferred();
		const first = await disk(undefined, async (sql, params) => {
			const key = phase === 'data' ? 'offline:a' : 'cursor:offline';
			if (sql.startsWith('INSERT') && params?.[0] === key) {
				entered.resolve();
				await release.promise;
			}
		});
		disposals.push(() => first.persistence.close!());
		const network = transport();
		network.client.query.mockImplementation(() => new Promise(() => {}));
		const { rows } = await open(first.persistence, network, {
			networkMode: 'manual',
			readOnly: true,
		});
		await rows.connect();
		network.emit(page(change('a', 1)));
		await entered.promise;
		const disconnect = rows.disconnect();
		release.resolve();
		await disconnect;
		const expectedCursor = phase === 'cursor' ? 1 : 0;
		expect((await first.persistence.kv.get('cursor:offline')) ?? 0).toBe(expectedCursor);
		await rows.connect();
		expect(network.subscriptions.at(-1)?.args.seq).toBe(expectedCursor);
		expect(rows.get('a')?.title).toBe('remote');
	}
);

test('disk rows become ready while all backend promises remain unresolved', async () => {
	const first = await disk();
	await seed(first.persistence);
	await first.persistence.close!();
	const reopened = await disk(first.path);
	disposals.push(() => reopened.persistence.close!());
	const net = transport();
	net.client.query.mockImplementation(() => new Promise(() => {}));
	net.client.mutation.mockImplementation(() => new Promise(() => {}));
	const { rows } = await open(reopened.persistence, net);
	expect(rows.get('a')?.title).toBe('persisted');
	await rows.disconnect();
});

test.each(['stream', 'recovery'])(
	'%s absence survives actual SQLite close and reopen',
	async (source) => {
		const first = await disk();
		await seed(first.persistence);
		const net = transport();
		if (source === 'recovery')
			net.client.query.mockResolvedValue({ mode: 'recovery', exists: false });
		const { rows } = await open(first.persistence, net);
		if (source === 'stream') {
			await vi.waitFor(() => expect(net.subscriptions.length).toBeGreaterThan(0));
			net.emit(page({ ...change('a', 1), exists: false }));
		}
		await vi.waitFor(() => expect(rows.get('a')).toBeUndefined());
		await rows.disconnect();
		await rows.cleanup();
		disposals.pop();
		await first.persistence.close!();
		const reopened = await disk(first.path);
		disposals.push(() => reopened.persistence.close!());
		const next = await open(reopened.persistence, transport(), { networkMode: 'manual' });
		expect(next.rows.get('a')).toBeUndefined();
		expect(await reopened.persistence.listDocuments('offline')).toEqual([]);
	}
);

test('manual read-only replica performs no transport before connect and never writes documents', async () => {
	const db = await disk();
	disposals.push(() => db.persistence.close!());
	await seed(db.persistence);
	const net = transport();
	const { rows } = await open(db.persistence, net, {
		networkMode: 'manual',
		readOnly: true,
		requestArgs: () => ({ guest: 'credential' }),
	});
	rows.session.subscribe(() => {});
	expect(net.client.query).not.toHaveBeenCalled();
	expect(net.client.onUpdate).not.toHaveBeenCalled();
	expect(net.client.mutation).not.toHaveBeenCalled();
	await rows.connect();
	net.emit(page(change('a', 1, 'server owned')));
	await vi.waitFor(() => expect(rows.get('a')?.title).toBe('server owned'));
	const transaction = rows.update('a', (row) => {
		row.title = 'forbidden';
	});
	await expect(transaction.isPersisted.promise).rejects.toThrow('read-only');
	expect(
		net.client.mutation.mock.calls.every(
			([ref]: any) => getFunctionName(ref) !== 'offline:replicate'
		)
	).toBe(true);
	for (const calls of [
		net.client.query.mock.calls,
		net.client.mutation.mock.calls,
		net.client.onUpdate.mock.calls,
	]) {
		for (const call of calls as any[]) expect(call[1].guest).toBe('credential');
	}
});

test('writable default still inserts and sends document updates', async () => {
	const db = await disk();
	disposals.push(() => db.persistence.close!());
	const { rows, network } = await open(db.persistence);
	await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
	let seq = 0;
	network.client.mutation.mockImplementation(async (ref: any, args: any) => {
		if (getFunctionName(ref) === 'offline:replicate')
			network.emit(page({ ...args, seq: ++seq, exists: true }));
		return { success: true, seq };
	});
	await rows.insert({ id: 'new', title: 'write' }).isPersisted.promise;
	await vi.waitFor(() => expect(rows.get('new')).toBeDefined());
	await rows.update('new', (row) => {
		row.title = 'edited';
	}).isPersisted.promise;
	expect(
		network.client.mutation.mock.calls.filter(
			([ref]: any) => getFunctionName(ref) === 'offline:replicate'
		)
	).toHaveLength(2);
	await vi.waitFor(() => expect(rows.get('new')?.title).toBe('edited'));
});

test.each(['insert', 'update', 'delete'] as const)(
	'local %s waits for durable persistence before remote acknowledgement',
	async (action) => {
		const entered = deferred();
		const release = deferred();
		const document = action === 'insert' ? 'new' : 'a';
		let block = false;
		const db = await disk(undefined, async (sql, params) => {
			if (
				block &&
				sql.startsWith('INSERT INTO deltas') &&
				params?.[0] === `offline:${document}`
			) {
				entered.resolve();
				await release.promise;
			}
		});
		disposals.push(() => db.persistence.close!());
		if (action !== 'insert') await seed(db.persistence);
		const { rows, network } = await open(db.persistence, transport(), {
			networkMode: 'manual',
		});
		await rows.connect();
		await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
		block = true;
		const transaction =
			action === 'insert'
				? rows.insert({ id: document, title: 'local' })
				: action === 'update'
					? rows.update(document, (row) => {
							row.title = 'local';
						})
					: rows.delete(document);
		let outcome = 'pending';
		const persisted = transaction.isPersisted.promise.then(
			() => {
				outcome = 'resolved';
			},
			(error) => {
				outcome = 'rejected';
				throw error;
			}
		);
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(outcome).toBe('pending');
		expect(
			network.client.mutation.mock.calls.some(
				([ref]: any) => getFunctionName(ref) === 'offline:replicate'
			)
		).toBe(false);
		if (action === 'insert') {
			expect(
				db.database
					.prepare("SELECT value FROM kv WHERE key = 'pending-create:offline:new'")
					.get()
			).toBeDefined();
		}
		release.resolve();
		await persisted;
		expect(outcome).toBe('resolved');
		expect(
			network.client.mutation.mock.calls.some(
				([ref, args]: any) =>
					getFunctionName(ref) === 'offline:replicate' && args.type === action
			)
		).toBe(true);
		if (action === 'insert') {
			expect(
				db.database
					.prepare("SELECT value FROM kv WHERE key = 'pending-create:offline:new'")
					.get()
			).toBeUndefined();
		}
		disposals.pop();
		disposals.pop();
		db.database.close();
		const reopened = await disk(db.path);
		disposals.push(() => reopened.persistence.close!());
		const next = await open(reopened.persistence, transport(), { networkMode: 'manual' });
		if (action === 'delete') expect(next.rows.get(document)).toBeUndefined();
		else expect(next.rows.get(document)?.title).toBe('local');
	}
);

test.each(['insert', 'update', 'delete'] as const)(
	'failed local %s persistence rejects before remote acknowledgement',
	async (action) => {
		const document = action === 'insert' ? 'new' : 'a';
		let fail = false;
		const db = await disk(undefined, async (sql, params) => {
			if (
				fail &&
				sql.startsWith('INSERT INTO deltas') &&
				params?.[0] === `offline:${document}`
			) {
				throw new Error('disk unavailable');
			}
		});
		disposals.push(() => db.persistence.close!());
		if (action !== 'insert') await seed(db.persistence);
		const { rows, network } = await open(db.persistence, transport(), {
			networkMode: 'manual',
		});
		await rows.connect();
		await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
		fail = true;
		const transaction =
			action === 'insert'
				? rows.insert({ id: document, title: 'local' })
				: action === 'update'
					? rows.update(document, (row) => {
							row.title = 'local';
						})
					: rows.delete(document);
		await expect(transaction.isPersisted.promise).rejects.toThrow('disk unavailable');
		expect(
			network.client.mutation.mock.calls.some(
				([ref]: any) => getFunctionName(ref) === 'offline:replicate'
			)
		).toBe(false);
		if (action === 'insert') {
			expect(
				db.database
					.prepare("SELECT value FROM kv WHERE key = 'pending-create:offline:new'")
					.get()
			).toBeDefined();
		}
		fail = false;
		await rows.disconnect();
	}
);

test('full-row updates remove omitted optional fields from outbound and reopened data', async () => {
	const first = await disk();
	disposals.push(() => first.persistence.close!());
	const net = transport();
	const { rows } = await open(first.persistence, net, { networkMode: 'manual' });
	let seq = 0;
	net.client.mutation.mockImplementation(async (ref: any, args: any) => {
		if (getFunctionName(ref) === 'offline:replicate')
			net.emit(page({ ...args, seq: ++seq, exists: true }));
		return { success: true, seq };
	});
	await rows.connect();
	await rows.insert({ id: 'optional', title: 'row', note: 'remove me' }).isPersisted.promise;
	await rows.update('optional', (row) => {
		row.note = undefined;
	}).isPersisted.promise;
	await vi.waitFor(() => expect(rows.get('optional')).not.toHaveProperty('note'));
	const update = net.client.mutation.mock.calls
		.filter(
			([ref, args]: any) => getFunctionName(ref) === 'offline:replicate' && args.type === 'update'
		)
		.at(-1)?.[1];
	expect(update.material).not.toHaveProperty('note');
	await rows.disconnect();
	await rows.cleanup();
	disposals.pop();
	await first.persistence.close!();

	const reopened = await disk(first.path);
	disposals.push(() => reopened.persistence.close!());
	const next = await open(reopened.persistence, transport(), { networkMode: 'manual' });
	expect(next.rows.get('optional')).toEqual({ id: 'optional', title: 'row' });
});

test('delayed data and cursor writes cannot be overtaken by marks or concurrent callbacks', async () => {
	const dataGate = deferred();
	const cursorGate = deferred();
	let delayData = true;
	let delayCursor = true;
	const db = await disk(undefined, async (sql) => {
		if (sql.startsWith('INSERT INTO deltas') && delayData) await dataGate.promise;
		if (sql.startsWith('INSERT OR REPLACE INTO kv') && delayCursor) await cursorGate.promise;
	});
	disposals.push(() => db.persistence.close!());
	// Client id is a kv write; allow initialization before delaying cursor specifically.
	delayCursor = false;
	const { rows, network } = await open(db.persistence);
	await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
	delayCursor = true;
	const callback = network.subscriptions[0].callback;
	callback(page(change('a', 1)));
	callback(page(change('a', 1), change('b', 2)));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(
		db.database.prepare("SELECT value FROM kv WHERE key = 'cursor:offline'").get()
	).toBeUndefined();
	expect(network.client.mutation).not.toHaveBeenCalled();
	delayData = false;
	dataGate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(
		db.database.prepare("SELECT value FROM kv WHERE key = 'cursor:offline'").get()
	).toBeUndefined();
	expect(network.client.mutation).not.toHaveBeenCalled();
	delayCursor = false;
	cursorGate.resolve();
	await vi.waitFor(() => expect(rows.get('b')).toBeDefined());
	await vi.waitFor(async () => expect(await db.persistence.kv.get('cursor:offline')).toBe(2));
});

test.each(['data', 'cursor'])(
	'failed %s writes retain progress and replay successfully',
	async (failure) => {
		let fail = false;
		const db = await disk(undefined, async (sql, params) => {
			if (
				fail &&
				((failure === 'data' && sql.startsWith('INSERT INTO deltas')) ||
					(failure === 'cursor' && sql.startsWith('INSERT') && params?.[0] === 'cursor:offline'))
			)
				throw new Error('disk unavailable');
		});
		disposals.push(() => db.persistence.close!());
		const { rows, network } = await open(db.persistence);
		await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
		fail = true;
		network.emit(page(change('a', 1)));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(await db.persistence.kv.get('cursor:offline')).toBeUndefined();
		expect(network.client.mutation).not.toHaveBeenCalled();
		fail = false;
		await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(1), {
			timeout: 2000,
		});
		network.emit(page(change('a', 1)));
		await vi.waitFor(() => expect(rows.get('a')?.title).toBe('remote'));
		await vi.waitFor(async () => expect(await db.persistence.kv.get('cursor:offline')).toBe(1));
	}
);

test('reset drains a delayed write and stale callbacks cannot resurrect disk data', async () => {
	const gate = deferred();
	let writing = false;
	const db = await disk(undefined, async (sql) => {
		if (sql.startsWith('INSERT INTO deltas')) {
			writing = true;
			await gate.promise;
		}
	});
	const { rows, network } = await open(db.persistence);
	await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
	const callback = network.subscriptions[0].callback;
	callback(page(change('a', 1)));
	await vi.waitFor(() => expect(writing).toBe(true));
	let done = false;
	const reset = rows.reset().then(() => {
		done = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(done).toBe(false);
	gate.resolve();
	await reset;
	callback(page(change('b', 2)));
	expect(await db.persistence.listDocuments('offline')).toEqual([]);
	expect(await db.persistence.kv.get('cursor:offline')).toBeUndefined();
	await rows.cleanup();
	disposals.pop();
	await db.persistence.close!();
	const reopened = await disk(db.path);
	disposals.push(() => reopened.persistence.close!());
	expect(await reopened.persistence.listDocuments('offline')).toEqual([]);
});

test('old recovery absence cannot remove a more recent stream version', async () => {
	const db = await disk();
	disposals.push(() => db.persistence.close!());
	await seed(db.persistence);
	const recovery = deferred<any>();
	const net = transport();
	net.client.query.mockImplementation(() => recovery.promise);
	const { rows } = await open(db.persistence, net);
	await vi.waitFor(() => expect(net.subscriptions.length).toBeGreaterThan(0));
	net.emit(page(change('a', 1, 'newer')));
	await vi.waitFor(() => expect(awaitableTitle(rows)).toBe('newer'));
	recovery.resolve({ mode: 'recovery', exists: false });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(rows.get('a')?.title).toBe('newer');
});
const awaitableTitle = (rows: any) => rows.get('a')?.title;

test('account generation rejects stale recovery and uses newly captured request context', async () => {
	const db = await disk();
	disposals.push(() => db.persistence.close!());
	await seed(db.persistence);
	const recovery = deferred<any>();
	const net = transport();
	net.client.query.mockImplementation(() => recovery.promise);
	let guest = 'first';
	const { rows } = await open(db.persistence, net, {
		networkMode: 'manual',
		requestArgs: () => ({ guest }),
	});
	await rows.connect();
	await rows.disconnect();
	guest = 'second';
	net.client.query.mockResolvedValue({ mode: 'recovery', exists: true });
	await rows.connect();
	recovery.resolve({ mode: 'recovery', exists: false });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(rows.get('a')).toBeDefined();
	expect((net.client.query.mock.calls.at(-1) as any)[1].guest).toBe('second');
});

test.each(['seq', 'document', 'interval', 'threshold', 'exclude'])(
	'request context rejects reserved %s',
	(key) => {
		const net = transport();
		const connection = createConnection(net.client as any, { requestArgs: () => ({ [key]: 1 }) });
		expect(() => connection.connect()).toThrow('protocol argument');
		expect(net.client.query).not.toHaveBeenCalled();
	}
);

test('raw incremental update survives disk restart before its compacted base arrives', async () => {
	const original = new Y.Doc();
	original.getMap('fields').set('title', 'base');
	const base = Y.encodeStateAsUpdateV2(original);
	const vector = Y.encodeStateVector(original);
	original.getMap('fields').set('title', 'latest');
	const delta = Y.encodeStateAsUpdateV2(original, vector);
	original.destroy();
	const db = await disk();
	const { rows, network } = await open(db.persistence);
	await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
	network.emit(page({ document: 'a', seq: 1, type: 'delta', exists: true, bytes: delta.buffer }));
	await vi.waitFor(async () => expect(await db.persistence.kv.get('cursor:offline')).toBe(1));
	await rows.disconnect();
	await rows.cleanup();
	disposals.pop();
	await db.persistence.close!();
	const reopened = await disk(db.path);
	disposals.push(() => reopened.persistence.close!());
	const next = await open(reopened.persistence);
	await vi.waitFor(() => expect(next.network.subscriptions.length).toBeGreaterThan(0));
	next.network.emit(
		page({ document: 'a', seq: 2, type: 'snapshot', exists: true, bytes: base.buffer })
	);
	await vi.waitFor(() => expect(next.rows.get('a')?.title).toBe('latest'));
});

test('SQLite clear rolls back both tables, fences writes, and survives reopen', async () => {
	const first = await disk();
	const source = new Y.Doc();
	source.getMap('fields').set('title', 'base');
	const base = Y.encodeStateAsUpdate(source);
	const vector = Y.encodeStateVector(source);
	source.getMap('fields').set('title', 'complete');
	const delta = Y.encodeStateAsUpdate(source, vector);
	first.database
		.prepare('INSERT INTO snapshots (collection, data) VALUES (?, ?)')
		.run('offline:a', base);
	first.database
		.prepare('INSERT INTO deltas (collection, data) VALUES (?, ?)')
		.run('offline:a', delta);
	first.database.exec(`
		CREATE TRIGGER reject_delta_delete
		BEFORE DELETE ON deltas
		BEGIN SELECT RAISE(ABORT, 'blocked delta delete'); END
	`);
	const loaded = new Y.Doc();
	const provider = first.persistence.createDocPersistence('offline:a', loaded);
	await provider.whenSynced;
	expect(loaded.getMap('fields').get('title')).toBe('complete');
	await expect(provider.clear!()).rejects.toThrow('blocked delta delete');
	expect(
		first.database
			.prepare("SELECT count(*) AS count FROM snapshots WHERE collection = 'offline:a'")
			.get()
	).toHaveProperty('count', 1);
	expect(
		first.database
			.prepare("SELECT count(*) AS count FROM deltas WHERE collection = 'offline:a'")
			.get()
	).toHaveProperty('count', 1);
	first.database.exec('DROP TRIGGER reject_delta_delete');
	await first.persistence.close!();

	const reopened = await disk(first.path);
	const restored = new Y.Doc();
	const retry = reopened.persistence.createDocPersistence('offline:a', restored);
	await retry.whenSynced;
	expect(restored.getMap('fields').get('title')).toBe('complete');
	await retry.clear!();
	await expect(retry.storeUpdate!(base)).rejects.toThrow('closed');
	await reopened.persistence.close!();

	const final = await disk(first.path);
	disposals.push(() => final.persistence.close!());
	expect(await final.persistence.listDocuments('offline')).toEqual([]);
	source.destroy();
	loaded.destroy();
	restored.destroy();
});

test('SQLite close releases the database after a queued write fails', async () => {
	const first = await disk(undefined, async (sql) => {
		if (sql.startsWith('INSERT INTO deltas')) throw new Error('injected write failure');
	});
	const doc = new Y.Doc();
	const provider = first.persistence.createDocPersistence('offline:a', doc);
	await provider.whenSynced;
	doc.getMap('fields').set('title', 'failure');
	await expect(provider.flush!()).rejects.toThrow('injected write failure');
	await expect(first.persistence.close!()).rejects.toThrow('injected write failure');
	expect(first.isClosed()).toBe(true);
	const reopened = await disk(first.path);
	disposals.push(() => reopened.persistence.close!());
	expect(await reopened.persistence.listDocuments('offline')).toEqual([]);
	doc.destroy();
});

test('custom adapter drains delayed updates before durable removal', async () => {
	const values = new Map<string, Uint8Array>();
	const gate = deferred();
	const p = createCustomPersistence({
		async get(key) {
			return values.get(key);
		},
		async keys(prefix) {
			return [...values.keys()].filter((k) => k.startsWith(prefix));
		},
		async set(key, value) {
			await gate.promise;
			values.set(key, value);
		},
		async delete(key) {
			values.delete(key);
		},
	});
	const doc = new Y.Doc();
	const provider = p.createDocPersistence('offline:a', doc);
	await provider.whenSynced;
	doc.getMap('fields').set('title', 'delayed');
	const clear = provider.clear!();
	gate.resolve();
	await clear;
	const next = p.createDocPersistence('offline:a', new Y.Doc());
	await next.whenSynced;
	expect(await p.listDocuments('offline')).toEqual([]);
	provider.destroy();
	next.destroy();
	doc.destroy();
});

test('a later disconnect wins over connect waiting for initialization', async () => {
	const db = await disk();
	disposals.push(() => db.persistence.close!());
	const net = transport();
	const gate = deferred();
	const original = db.persistence.listDocuments;
	db.persistence.listDocuments = async (prefix) => {
		await gate.promise;
		return original(prefix);
	};
	const lazy = collection.create<{ id: string; title: string }>({
		schema: definition,
		persistence: async () => db.persistence,
		config: () => ({ convexClient: net.client as any, api, getKey: (row) => row.id }),
	});
	await lazy.init();
	const rows = lazy.get();
	const loading = rows.preload();
	const connecting = rows.connect();
	const closing = rows.disconnect();
	gate.resolve();
	await Promise.all([loading, connecting, closing]);
	expect(net.client.query).not.toHaveBeenCalled();
	expect(net.client.onUpdate).not.toHaveBeenCalled();
	await rows.cleanup();
});

test('connect waits for reset data removal before starting the next generation', async () => {
	const gate = deferred();
	let deleting = false;
	const db = await disk(undefined, async (sql) => {
		if (sql.startsWith('DELETE FROM snapshots')) {
			deleting = true;
			await gate.promise;
		}
	});
	disposals.push(() => db.persistence.close!());
	await seed(db.persistence);
	const { rows, network } = await open(db.persistence);
	await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
	const reset = rows.reset();
	await vi.waitFor(() => expect(deleting).toBe(true));
	const previous = network.subscriptions.length;
	const connecting = rows.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(network.subscriptions.length).toBe(previous);
	gate.resolve();
	await Promise.all([reset, connecting]);
	expect(network.subscriptions.at(-1)?.args.seq).toBe(0);
	expect(rows.get('a')).toBeUndefined();
});

test('writable offline creation survives restart and retries as insert after authorized connection', async () => {
	const db = await disk();
	const { rows } = await open(db.persistence, transport(), { networkMode: 'manual' });
	await expect(
		rows.insert({ id: 'offline-new', title: 'unsent' }).isPersisted.promise
	).rejects.toThrow('disconnected');
	await rows.disconnect();
	await rows.cleanup();
	disposals.pop();
	await db.persistence.close!();
	const reopened = await disk(db.path);
	disposals.push(() => reopened.persistence.close!());
	const net = transport();
	net.client.query.mockResolvedValue({ mode: 'recovery', exists: false, known: false });
	const next = await open(reopened.persistence, net, { networkMode: 'manual' });
	expect(next.rows.get('offline-new')?.title).toBe('unsent');
	await next.rows.connect();
	await vi.waitFor(() =>
		expect(net.client.mutation.mock.calls.some((call: any) => call[1].type === 'insert')).toBe(true)
	);
	expect(next.rows.get('offline-new')?.title).toBe('unsent');
});

test('presence and marks exclude local edits whose writes are still delayed', async () => {
	const cursorGate = deferred();
	const localGate = deferred();
	let blockCursor = false;
	let blockLocal = false;
	const db = await disk(undefined, async (sql, params) => {
		if (blockCursor && sql.startsWith('INSERT') && params?.[0] === 'cursor:offline')
			await cursorGate.promise;
		if (blockLocal && sql.startsWith('INSERT INTO deltas')) await localGate.promise;
	});
	disposals.push(() => db.persistence.close!());
	const { rows, network } = await open(db.persistence);
	await vi.waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(0));
	network.emit(page(change('a', 1)));
	await vi.waitFor(() => expect(rows.get('a')).toBeDefined());
	const before = network.client.mutation.mock.calls.find(
		(call: any) => call[1].action === 'mark'
	) as any;
	const durable = new Uint8Array(before[1].vector);
	blockCursor = true;
	network.emit(page(change('b', 2)));
	await new Promise((resolve) => setTimeout(resolve, 20));
	blockLocal = true;
	const update = rows.update('a', (row) => {
		row.title = 'not durable';
	});
	const handle = rows.doc('a');
	handle.presence.join();
	cursorGate.resolve();
	await vi.waitFor(() =>
		expect(network.client.mutation.mock.calls.some((call: any) => call[1].action === 'join')).toBe(
			true
		)
	);
	const join = network.client.mutation.mock.calls.find(
		(call: any) => call[1].action === 'join'
	) as any;
	expect(new Uint8Array(join[1].vector)).toEqual(durable);
	localGate.resolve();
	await update.isPersisted.promise;
	await rows.disconnect();
});

test('encrypted raw updates survive compaction, disk reopen, and durable removal', async () => {
	const db = await disk();
	const config = (storage: Persistence) => ({
		storage,
		user: 'test',
		unlock: {
			passphrase: {
				setup: async () => 'test-only-password',
				get: async () => 'test-only-password',
			},
		},
	});
	const encrypted = await createWebEncryptionPersistence(config(db.persistence));
	await encrypted.unlock();
	const local = new Y.Doc();
	const provider = encrypted.createDocPersistence('offline:a', local);
	await provider.whenSynced;
	const server = new Y.Doc();
	server.getMap('fields').set('title', 'base');
	const base = Y.encodeStateAsUpdateV2(server);
	for (let index = 0; index < 50; index++) {
		const vector = Y.encodeStateVector(server);
		server.getMap('fields').set('title', `value-${index}`);
		const update = Y.encodeStateAsUpdateV2(server, vector);
		await provider.storeUpdate!(update);
		Y.applyUpdateV2(local, update, 'replicate-persisted');
	}
	provider.destroy();
	await db.persistence.close!();
	const reopened = await disk(db.path);
	disposals.push(() => reopened.persistence.close!());
	const next = await createWebEncryptionPersistence(config(reopened.persistence));
	await next.unlock();
	expect(await next.listDocuments('offline')).toEqual(['a']);
	const restored = new Y.Doc();
	const nextProvider = next.createDocPersistence('offline:a', restored);
	await nextProvider.whenSynced;
	await nextProvider.storeUpdate!(base);
	Y.applyUpdateV2(restored, base, 'replicate-persisted');
	expect(restored.getMap('fields').get('title')).toBe('value-49');
	await nextProvider.clear!();
	expect(await next.listDocuments('offline')).toEqual([]);
	server.destroy();
	local.destroy();
	restored.destroy();
});

test('an insert before preload is not invalidated by initial automatic activation', async () => {
	const db = await disk();
	disposals.push(() => db.persistence.close!());
	const net = transport();
	const lazy = collection.create<{ id: string; title: string }>({
		schema: definition,
		persistence: async () => db.persistence,
		config: () => ({ convexClient: net.client as any, api, getKey: (row) => row.id }),
	});
	await lazy.init();
	const rows = lazy.get();
	const transaction = rows.insert({ id: 'early', title: 'accepted' });
	await rows.preload();
	await transaction.isPersisted.promise;
	expect(net.client.mutation.mock.calls.some((call: any) => call[1].type === 'insert')).toBe(true);
	await rows.disconnect();
	await rows.cleanup();
});
