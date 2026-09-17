import { expect, test } from 'vitest';
import { convexTest } from 'convex-test';
import { defineSchema, defineTable, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import * as Y from 'yjs';
import componentSchema from '../component/schema';
import { modules } from '../component/test.setup';
const appSchema = defineSchema({
	records: defineTable({
		id: v.string(),
		title: v.string(),
		timestamp: v.optional(v.number()),
	}).index('by_doc_id', ['id']),
});
const appModules = {
	'./_generated/server.ts': async () => ({}),
	'./functions.ts': () => import('./server-functions'),
};

test('actual server recovery distinguishes absent material from unknown component history', async () => {
	const t = convexTest(appSchema, appModules);
	t.registerComponent('replicate', componentSchema, modules);
	const doc = new Y.Doc();
	doc.getMap('fields').set('title', 'record');
	const vector = Y.encodeStateVector(new Y.Doc()).buffer as ArrayBuffer;
	const delta = makeFunctionReference<'query'>('functions:delta');
	const missing = await t.query(delta, { document: 'missing', vector });
	expect(missing).toMatchObject({ exists: false, known: false });
	const id = await t.run((ctx) => ctx.db.insert('records', { id: 'a', title: 'record' }));
	// Access component through the same generated component reference as application functions.
	await t.run(async (ctx) => {
		const { componentsGeneric } = await import('convex/server');
		await ctx.runMutation((componentsGeneric() as any).replicate.mutations.insertDocument, {
			collection: 'records',
			document: 'a',
			bytes: Y.encodeStateAsUpdateV2(doc).buffer as ArrayBuffer,
		});
	});
	expect(await t.query(delta, { document: 'a', vector })).toMatchObject({
		exists: true,
		known: true,
	});
	await t.run((ctx) => ctx.db.delete(id));
	expect(await t.query(delta, { document: 'a', vector })).toMatchObject({
		exists: false,
		known: true,
	});
	doc.destroy();
});

test('retried create after an earlier commit does not duplicate logical records', async () => {
	const t = convexTest(appSchema, appModules);
	t.registerComponent('replicate', componentSchema, modules);
	const doc = new Y.Doc();
	doc.getMap('fields').set('title', 'once');
	const args = {
		document: 'retry',
		bytes: Y.encodeStateAsUpdateV2(doc).buffer as ArrayBuffer,
		material: { id: 'retry', title: 'once' },
		type: 'insert',
	};
	const mutation = makeFunctionReference<'mutation'>('functions:replicate');
	const absent = await t.query(makeFunctionReference<'query'>('functions:delta'), {
		document: 'retry',
		vector: Y.encodeStateVector(new Y.Doc()).buffer as ArrayBuffer,
	});
	expect(absent.exists).toBe(false);
	const original = await t.mutation(mutation, args);
	doc.getMap('fields').set('title', 'newer offline edit');
	const retry = await t.mutation(mutation, {
		...args,
		bytes: Y.encodeStateAsUpdateV2(doc).buffer as ArrayBuffer,
		material: { id: 'retry', title: 'newer offline edit' },
	});
	expect(retry.seq).toBeGreaterThan(original.seq);
	const recovered = await t.query(makeFunctionReference<'query'>('functions:delta'), {
		document: 'retry',
		vector: Y.encodeStateVector(new Y.Doc()).buffer as ArrayBuffer,
	});
	const merged = new Y.Doc();
	Y.applyUpdateV2(merged, new Uint8Array(recovered.diff));
	expect(merged.getMap('fields').get('title')).toBe('newer offline edit');
	merged.destroy();
	expect(await t.run((ctx) => ctx.db.query('records').first())).toMatchObject({
		title: 'newer offline edit',
	});
	expect(await t.run((ctx) => ctx.db.query('records').collect())).toHaveLength(1);
	doc.destroy();
});
