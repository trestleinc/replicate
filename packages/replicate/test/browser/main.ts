import { collection, persistence } from '@trestleinc/replicate/client';
import { schema } from '@trestleinc/replicate/server';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import * as Y from 'yjs';
import Worker from '@trestleinc/replicate/worker?worker';

const api = Object.fromEntries(
	['material', 'delta', 'replicate', 'presence', 'session'].map((name) => [
		name,
		makeFunctionReference(`browser:${name}`),
	])
);
let callback: ((page: unknown) => void) | undefined;
let calls = 0;
let absent = false;
const transport = {
	query: async () => {
		calls++;
		return { mode: 'recovery', exists: !absent, diff: null };
	},
	mutation: async () => {
		calls++;
		return null;
	},
	onUpdate: (_api: unknown, _args: unknown, cb: typeof callback) => {
		calls++;
		callback = cb;
		return () => {
			callback = undefined;
		};
	},
};
const local = await persistence.web.sqlite.create({
	name: 'offline-browser',
	worker: () => new Worker(),
	assetBase: '/sqlite',
});
const lazy = collection.create<{ id: string; title: string }>({
	schema: schema.define({
		shape: v.object({ id: v.string(), title: v.string() }),
		defaults: {},
		history: {},
	}),
	persistence: async () => local,
	config: () => ({ convexClient: transport as any, api: api as any, getKey: (row) => row.id }),
	networkMode: 'manual',
	readOnly: true,
});
await lazy.init();
const rows = lazy.get();
await rows.preload();
Object.assign(window, {
	replica: {
		get: (id: string) => rows.get(id),
		calls: () => calls,
		connect: () => rows.connect(),
		disconnect: () => rows.disconnect(),
		reset: () => rows.reset(),
		absent: () => {
			absent = true;
		},
		cursor: () => local.kv.get('cursor:browser'),
		close: async () => {
			await rows.disconnect();
			await rows.cleanup();
			await local.close!();
		},
		emit: (id: string, seq: number, exists = true, raw?: number[]) => {
			const doc = new Y.Doc();
			doc.getMap('fields').set('title', 'persisted in browser');
			const bytes = raw ? new Uint8Array(raw) : Y.encodeStateAsUpdateV2(doc);
			doc.destroy();
			callback?.({
				mode: 'stream',
				changes: [{ document: id, seq, bytes: bytes.buffer, exists, type: 'snapshot' }],
				seq,
			});
		},
	},
});
await navigator.serviceWorker.register('/sw.js');
await navigator.serviceWorker.ready;
