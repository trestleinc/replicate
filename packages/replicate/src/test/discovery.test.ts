import { afterEach, expect, test, vi } from 'vitest';
import { convexTest } from 'convex-test';
import * as Y from 'yjs';
import { api } from '../component/_generated/api';
import schema from '../component/schema';
import { modules } from '../component/test.setup';

const collection = 'discovery';
const make = () => convexTest(schema, modules);
type Backend = ReturnType<typeof make>;
function document(title: string) {
	const doc = new Y.Doc();
	doc.getMap('fields').set('title', title);
	return doc;
}
const bytes = (doc: Y.Doc) => Y.encodeStateAsUpdateV2(doc).buffer as ArrayBuffer;
async function insert(t: Backend, id: string, doc: Y.Doc) {
	await t.mutation(api.mutations.insertDocument, { collection, document: id, bytes: bytes(doc) });
}
async function compact(t: Backend, id: string) {
	await t.mutation(api.mutations.compact, { collection, document: id });
}
async function read(
	t: Backend,
	limit: number,
	cursor = 0,
	between?: (page: number) => Promise<void>
) {
	const docs = new Map<string, Y.Doc>();
	const sequences: number[] = [];
	for (let page = 0; page < 30; page++) {
		const result = await t.query(api.mutations.stream, { collection, seq: cursor, limit });
		expect(result.changes.length).toBeLessThanOrEqual(limit);
		for (const change of result.changes) {
			expect(change.seq).toBeGreaterThan(cursor);
			sequences.push(change.seq);
			const doc = docs.get(change.document) ?? new Y.Doc();
			docs.set(change.document, doc);
			Y.applyUpdateV2(doc, new Uint8Array(change.bytes));
		}
		if (!result.changes.length) break;
		cursor = result.seq;
		await between?.(page);
	}
	const titles = Object.fromEntries(
		[...docs].map(([id, doc]) => [id, doc.getMap('fields').get('title')])
	);
	for (const doc of docs.values()) doc.destroy();
	expect(new Set(sequences).size).toBe(sequences.length);
	return { titles, cursor };
}
afterEach(() => vi.useRealTimers());

test.each([1, 2])(
	'fresh client discovers a fully compacted collection with page limit %s',
	async (limit) => {
		const t = make();
		for (const id of ['a', 'b', 'c']) {
			const doc = document(id);
			await insert(t, id, doc);
			await compact(t, id);
			doc.destroy();
		}
		expect(await t.run((ctx) => ctx.db.query('deltas').collect())).toEqual([]);
		expect((await read(t, limit)).titles).toEqual({ a: 'a', b: 'b', c: 'c' });
	}
);

test.each([1, 2])(
	'mixed snapshots and incremental deltas converge with page limit %s',
	async (limit) => {
		const t = make();
		const a = document('base');
		await insert(t, 'a', a);
		await compact(t, 'a');
		const vector = Y.encodeStateVector(a);
		a.getMap('fields').set('title', 'latest');
		await t.mutation(api.mutations.updateDocument, {
			collection,
			document: 'a',
			bytes: Y.encodeStateAsUpdateV2(a, vector).buffer as ArrayBuffer,
		});
		const b = document('b');
		await insert(t, 'b', b);
		expect((await read(t, limit)).titles).toEqual({ a: 'latest', b: 'b' });
		a.destroy();
		b.destroy();
	}
);

test.each([1, 2])(
	'writes and compaction between pages remain discoverable at limit %s',
	async (limit) => {
		const t = make();
		const a = document('a');
		const b = document('b');
		await insert(t, 'a', a);
		await insert(t, 'b', b);
		const result = await read(t, limit, 0, async (page) => {
			if (page !== 0) return;
			a.getMap('fields').set('title', 'new-a');
			await insert(t, 'a', a);
			await compact(t, 'a');
			await compact(t, 'b');
			const c = document('c');
			await insert(t, 'c', c);
			await compact(t, 'c');
			c.destroy();
		});
		expect(result.titles).toEqual({ a: 'new-a', b: 'b', c: 'c' });
		a.destroy();
		b.destroy();
	}
);

test.each([undefined, 2])(
	'legacy shared snapshot positions migrate above cursor with counter %s',
	async (counter) => {
		const t = make();
		await t.run(async (ctx) => {
			if (counter !== undefined) await ctx.db.insert('sequences', { collection, seq: counter });
			for (const id of ['a', 'b', 'c']) {
				const doc = document(id);
				await ctx.db.insert('snapshots', {
					collection,
					document: id,
					bytes: bytes(doc),
					vector: Y.encodeStateVector(doc).buffer as ArrayBuffer,
					seq: 10,
					created: 0,
				});
				doc.destroy();
			}
		});
		await expect(t.query(api.mutations.stream, { collection, seq: 10, limit: 1 })).rejects.toThrow(
			'migration required'
		);
		const first = await t.mutation(api.mutations.migrateSnapshots, { collection, limit: 1 });
		expect(first).toEqual({ migrated: 1, done: false });
		await expect(t.query(api.mutations.stream, { collection, seq: 10, limit: 1 })).rejects.toThrow(
			'migration required'
		);
		// A write between restartable migration batches uses the same allocator.
		const d = document('d');
		await insert(t, 'd', d);
		d.destroy();
		const second = await t.mutation(api.mutations.migrateSnapshots, { collection, limit: 2 });
		expect(second).toEqual({ migrated: 2, done: true });
		expect(await t.mutation(api.mutations.migrateSnapshots, { collection, limit: 1 })).toEqual({
			migrated: 0,
			done: true,
		});
		expect((await read(t, 1, 10)).titles).toEqual({ a: 'a', b: 'b', c: 'c', d: 'd' });
	}
);

test('legacy base republished after its incremental delta still supports discovery and recovery', async () => {
	const t = make();
	const doc = document('old');
	const base = bytes(doc);
	const vector = Y.encodeStateVector(doc);
	doc.getMap('fields').set('title', 'new');
	await t.run(async (ctx) => {
		await ctx.db.insert('snapshots', {
			collection,
			document: 'a',
			bytes: base,
			vector: vector.buffer as ArrayBuffer,
			seq: 10,
			created: 0,
		});
		await ctx.db.insert('deltas', {
			collection,
			document: 'a',
			bytes: Y.encodeStateAsUpdateV2(doc, vector).buffer as ArrayBuffer,
			seq: 11,
		});
	});
	await t.mutation(api.mutations.migrateSnapshots, { collection });
	expect((await read(t, 1)).titles).toEqual({ a: 'new' });
	const recovered = new Y.Doc();
	const result = await t.query(api.mutations.recovery, {
		collection,
		document: 'a',
		vector: Y.encodeStateVector(recovered).buffer as ArrayBuffer,
	});
	Y.applyUpdateV2(recovered, new Uint8Array(result.diff!));
	expect(recovered.getMap('fields').get('title')).toBe('new');
	doc.destroy();
	recovered.destroy();
});

test('scheduled compaction publishes snapshots and preserves configured delta retention', async () => {
	vi.useFakeTimers();
	const t = make();
	const doc = document('one');
	await insert(t, 'a', doc);
	doc.getMap('fields').set('title', 'two');
	await insert(t, 'a', doc);
	const scheduled = await t.mutation(api.mutations.scheduleCompaction, {
		collection,
		document: 'a',
		retain: 1,
	});
	expect(scheduled.status).toBe('scheduled');
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	const deltas = await t.run((ctx) => ctx.db.query('deltas').collect());
	expect(deltas).toHaveLength(1);
	expect((await read(t, 1)).titles).toEqual({ a: 'two' });
	doc.destroy();
});

test('snapshot publication does not acknowledge data for a connected old client', async () => {
	const t = make();
	const doc = document('a');
	await insert(t, 'a', doc);
	await t.mutation(api.mutations.mark, {
		collection,
		document: 'a',
		client: 'old',
		seq: 0,
		vector: Y.encodeStateVector(new Y.Doc()).buffer as ArrayBuffer,
	});
	await t.run(async (ctx) => {
		const session = await ctx.db.query('sessions').first();
		await ctx.db.patch(session!._id, { connected: true });
	});
	await compact(t, 'a');
	expect((await t.run((ctx) => ctx.db.query('deltas').collect())).length).toBe(1);
	expect((await read(t, 1)).titles).toEqual({ a: 'a' });
	doc.destroy();
});
test('seeded interleavings converge after legacy migration, writes, compaction, and paging', async () => {
	for (let seed = 1; seed <= 24; seed++) {
		let state = seed;
		const nextRandom = (max: number) => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state % max;
		};
		const t = convexTest(schema, modules),
			collection = 'interleavings';
		const sourceDocuments = Array.from({ length: 7 }, (_, id) => {
			const doc = new Y.Doc();
			doc.getMap('fields').set('title', String(id));
			return doc;
		});
		const receivedDocuments = sourceDocuments.map(() => new Y.Doc());
		let cursor = 10;
		await t.run(async (ctx) => {
			for (let id = 0; id < 7; id++) {
				const doc = sourceDocuments[id];
				await ctx.db.insert('snapshots', {
					collection,
					document: String(id),
					bytes: Y.encodeStateAsUpdateV2(doc).buffer as ArrayBuffer,
					vector: Y.encodeStateVector(doc).buffer as ArrayBuffer,
					seq: 10,
					created: 0,
				});
			}
		});
		const write = async (id: number, value: number) => {
			const doc = sourceDocuments[id],
				vector = Y.encodeStateVector(doc);
			doc.getMap('fields').set('title', String(value));
			await t.mutation(api.mutations.updateDocument, {
				collection,
				document: String(id),
				bytes: Y.encodeStateAsUpdateV2(doc, vector).buffer as ArrayBuffer,
			});
		};
		for (let n = 0; n < 7; n++) {
			await t.mutation(api.mutations.migrateSnapshots, { collection, limit: 1 });
			await write(nextRandom(7), n + 100);
			if (nextRandom(2))
				await t.mutation(api.mutations.compact, { collection, document: String(nextRandom(7)) });
		}
		const readPage = async () => {
			const response = await t.query(api.mutations.stream, {
				collection,
				seq: cursor,
				limit: nextRandom(2) + 1,
			});
			for (const change of response.changes) {
				expect(change.seq).toBeGreaterThan(cursor);
				Y.applyUpdateV2(receivedDocuments[Number(change.document)], new Uint8Array(change.bytes));
			}
			cursor = response.seq;
			return response.changes.length;
		};
		for (let n = 0; n < 80; n++) {
			const action = nextRandom(3);
			if (action === 0) await write(nextRandom(7), n + 200);
			else if (action === 1)
				await t.mutation(api.mutations.compact, { collection, document: String(nextRandom(7)) });
			else await readPage();
		}
		let drained = false;
		for (let remaining = 200; remaining > 0; remaining--) {
			if ((await readPage()) === 0) {
				drained = true;
				break;
			}
		}
		expect(drained, 'stream drains after writes stop').toBe(true);
		expect(
			receivedDocuments.map((doc) => doc.getMap('fields').toJSON()),
			`seed ${seed}`
		).toEqual(sourceDocuments.map((doc) => doc.getMap('fields').toJSON()));
		for (const doc of [...sourceDocuments, ...receivedDocuments]) doc.destroy();
	}
}, 30000);
