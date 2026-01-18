import { test, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import * as Y from "yjs";
import { api } from "../../component/_generated/api";
import schema from "../../component/schema";
import { modules } from "../../component/test.setup";

const toArrayBuffer = (data: Uint8Array): ArrayBuffer =>
	data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

test("scheduleCompaction_createsJobWithPendingStatus", async () => {
	vi.useFakeTimers();
	const t = convexTest(schema, modules);

	const docId = "job-1";

	await t.mutation(api.mutations.insertDocument, {
		collection: "test",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	await t.mutation(api.mutations.scheduleCompaction, {
		collection: "test",
		document: docId,
	});

	// Jobs are created with "pending" status, then transition to "running" when scheduler executes
	const pendingJob = await t.run(async ctx => {
		return await ctx.db
			.query("compaction")
			.withIndex("by_document", q =>
				q.eq("collection", "test").eq("document", docId).eq("status", "pending"),
			)
			.first();
	});

	expect(pendingJob).not.toBeNull();
	expect(pendingJob?.status).toBe("pending");

	// Clean up scheduled functions
	vi.runAllTimers();
	await t.finishInProgressScheduledFunctions();
	vi.useRealTimers();
});

test("scheduleCompaction_dedup_pendingJobs", async () => {
	vi.useFakeTimers();
	const t = convexTest(schema, modules);

	const docId = "job-2";

	await t.mutation(api.mutations.insertDocument, {
		collection: "test",
		document: docId,
		bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(new Y.Doc())),
	});

	await t.mutation(api.mutations.scheduleCompaction, {
		collection: "test",
		document: docId,
	});

	const pendingJob = await t.run(async ctx => {
		return await ctx.db
			.query("compaction")
			.withIndex("by_document", q =>
				q.eq("collection", "test").eq("document", docId).eq("status", "pending"),
			)
			.first();
	});

	expect(pendingJob).not.toBeNull();
	expect(pendingJob?.status).toBe("pending");

	// Clean up scheduled functions
	vi.runAllTimers();
	await t.finishInProgressScheduledFunctions();
	vi.useRealTimers();
});

test("runCompaction_createsSnapshotFromDeltas", async () => {
	vi.useFakeTimers();
	const t = convexTest(schema, modules);

	const docId = "compact-1";

	const ydoc = new Y.Doc();
	ydoc.getMap("fields").set("text", "test data");
	const delta = Y.encodeStateAsUpdateV2(ydoc);

	await t.mutation(api.mutations.insertDocument, {
		collection: "test",
		document: docId,
		bytes: toArrayBuffer(delta),
	});

	// Schedule compaction to get a real job ID
	const scheduleResult = await t.mutation(api.mutations.scheduleCompaction, {
		collection: "test",
		document: docId,
	});

	// Run compaction with the real ID
	const result = await t.mutation(api.mutations.runCompaction, {
		id: scheduleResult.id!,
	});

	expect(result).toMatchObject({
		removed: expect.any(Number),
		retained: expect.any(Number),
	});

	const snapshot = await t.run(async ctx => {
		return await ctx.db
			.query("snapshots")
			.withIndex("by_document", q => q.eq("collection", "test").eq("document", docId))
			.first();
	});

	expect(snapshot).not.toBeNull();
	ydoc.destroy();

	// Clean up scheduled functions
	vi.runAllTimers();
	await t.finishInProgressScheduledFunctions();
	vi.useRealTimers();
});

test("runCompaction_retainsDeltasWhenActivePeerNeedsData", async () => {
	vi.useFakeTimers();
	const t = convexTest(schema, modules);

	const docId = "compact-2";
	const peerId = "peer-1";

	const ydocOld = new Y.Doc();
	ydocOld.getMap("fields").set("text", "old data");
	const oldDelta = Y.encodeStateAsUpdateV2(ydocOld);

	await t.mutation(api.mutations.insertDocument, {
		collection: "test",
		document: docId,
		bytes: toArrayBuffer(oldDelta),
	});

	const ydocNew = new Y.Doc();
	ydocNew.getMap("fields").set("text", "new data");
	const newDelta = Y.encodeStateAsUpdateV2(ydocNew);

	await t.mutation(api.mutations.insertDocument, {
		collection: "test",
		document: docId,
		bytes: toArrayBuffer(newDelta),
	});

	await t.mutation(api.mutations.presence, {
		collection: "test",
		document: docId,
		client: peerId,
		action: "join",
		vector: toArrayBuffer(Y.encodeStateVector(ydocOld)),
	});

	// Schedule compaction to get a real job ID
	const scheduleResult = await t.mutation(api.mutations.scheduleCompaction, {
		collection: "test",
		document: docId,
	});

	const result = await t.mutation(api.mutations.runCompaction, {
		id: scheduleResult.id!,
	});

	expect(result).toMatchObject({
		removed: 0,
		retained: expect.any(Number),
	});

	const deltas = await t.run(async ctx => {
		return await ctx.db
			.query("deltas")
			.withIndex("by_document", q => q.eq("collection", "test").eq("document", docId))
			.collect();
	});

	expect(deltas.length).toBeGreaterThan(0);
	ydocOld.destroy();
	ydocNew.destroy();

	// Clean up scheduled functions
	vi.runAllTimers();
	await t.finishInProgressScheduledFunctions();
	vi.useRealTimers();
});
