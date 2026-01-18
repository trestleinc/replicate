import { test, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import * as Y from "yjs";
import { api } from "../../component/_generated/api";
import schema from "../../component/schema";
import { modules } from "../../component/test.setup";

const toArrayBuffer = (data: Uint8Array): ArrayBuffer =>
	data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

test("insertDocument_persistsDeltaWithIncrementingSeq", async () => {
	const t = convexTest(schema, modules);

	const docId = "task-1";

	await t.mutation(api.mutations.insertDocument, {
		collection: "tasks",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	await t.mutation(api.mutations.insertDocument, {
		collection: "tasks",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	await t.mutation(api.mutations.insertDocument, {
		collection: "tasks",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	const deltas = await t.run(async ctx => {
		return await ctx.db
			.query("deltas")
			.withIndex("by_document", q => q.eq("collection", "tasks").eq("document", docId))
			.collect();
	});

	expect(deltas).toHaveLength(3);
	expect(deltas[0].seq).toBe(1);
	expect(deltas[1].seq).toBe(2);
	expect(deltas[2].seq).toBe(3);
});

test("insertDocument_triggersCompactionAtThreshold", async () => {
	vi.useFakeTimers();
	const t = convexTest(schema, modules);

	const docId = "compact-doc";

	for (let i = 0; i < 500; i++) {
		await t.mutation(api.mutations.insertDocument, {
			collection: "test",
			document: docId,
			bytes: toArrayBuffer(new Uint8Array([i % 256])),
		});
	}

	const deltas = await t.run(async ctx => {
		return await ctx.db
			.query("deltas")
			.withIndex("by_document", q => q.eq("collection", "test").eq("document", docId))
			.collect();
	});

	expect(deltas.length).toBeGreaterThanOrEqual(500);

	const job = await t.run(async ctx => {
		return await ctx.db
			.query("compaction")
			.withIndex("by_document", q =>
				q.eq("collection", "test").eq("document", docId).eq("status", "pending"),
			)
			.first();
	});

	expect(job).not.toBeNull();

	vi.useRealTimers();
});

test("updateDocument_persistsDeltaWithIncrementingSeq", async () => {
	const t = convexTest(schema, modules);

	const docId = "task-1";

	await t.mutation(api.mutations.insertDocument, {
		collection: "tasks",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	await t.mutation(api.mutations.updateDocument, {
		collection: "tasks",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	const deltas = await t.run(async ctx => {
		return await ctx.db
			.query("deltas")
			.withIndex("by_document", q => q.eq("collection", "tasks").eq("document", docId))
			.collect();
	});

	expect(deltas).toHaveLength(2);
	expect(deltas[0].seq).toBe(1);
	expect(deltas[1].seq).toBe(2);
});

test("deleteDocument_persistsDeltaWithIncrementingSeq", async () => {
	const t = convexTest(schema, modules);

	const docId = "task-1";

	await t.mutation(api.mutations.insertDocument, {
		collection: "tasks",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	await t.mutation(api.mutations.deleteDocument, {
		collection: "tasks",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	const deltas = await t.run(async ctx => {
		return await ctx.db
			.query("deltas")
			.withIndex("by_document", q => q.eq("collection", "tasks").eq("document", docId))
			.collect();
	});

	expect(deltas).toHaveLength(2);
	expect(deltas[0].seq).toBe(1);
	expect(deltas[1].seq).toBe(2);
});
