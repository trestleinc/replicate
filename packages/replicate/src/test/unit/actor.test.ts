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
	const docId = "seq-test";

	await t.mutation(api.mutations.insertDocument, {
		collection: "test",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	await t.mutation(api.mutations.insertDocument, {
		collection: "test",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	const deltas = await t.run(async ctx => {
		return await ctx.db
			.query("deltas")
			.withIndex("by_document", q => q.eq("collection", "test").eq("document", docId))
			.collect();
	});

	expect(deltas).toHaveLength(2);
	expect(deltas[0].seq).toBe(1);
	expect(deltas[1].seq).toBe(2);
});

test("insertDocument_triggersCompactionAtThreshold", async () => {
	vi.useFakeTimers();
	const t = convexTest(schema, modules);

	const docId = "compact-trigger";

	// Insert valid Yjs updates - each update builds on the base doc
	const ydoc = new Y.Doc();
	const map = ydoc.getMap("fields");

	for (let i = 0; i < 500; i++) {
		map.set("counter", i);
		await t.mutation(api.mutations.insertDocument, {
			collection: "test",
			document: docId,
			bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(ydoc)),
		});
	}

	const job = await t.run(async ctx => {
		return await ctx.db
			.query("compaction")
			.withIndex("by_document", q =>
				q.eq("collection", "test").eq("document", docId).eq("status", "pending"),
			)
			.first();
	});

	expect(job).not.toBeNull();

	vi.runAllTimers();
	await t.finishInProgressScheduledFunctions();

	const result = await t.run(async ctx => {
		return await ctx.db
			.query("compaction")
			.withIndex("by_document", q =>
				q.eq("collection", "test").eq("document", docId).eq("status", "done"),
			)
			.first();
	});

	expect(result).not.toBeNull();
	ydoc.destroy();
	vi.useRealTimers();
});
