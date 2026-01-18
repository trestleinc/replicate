import { describe, it, expect, beforeEach, vi } from "vitest";
import { convexTest } from "convex-test";
import * as Y from "yjs";
import { api } from "../component/_generated/api";
import schema from "../component/schema";
import { modules } from "../component/test.setup";

describe("Replicate Component Mutations", () => {
	let t: ReturnType<typeof convexTest>;

	beforeEach(() => {
		t = convexTest(schema, modules);
	});

	describe("insertDocument", () => {
		it("should insert a document delta and return success with seq", async () => {
			const bytes = new Uint8Array([1, 2, 3, 4]);

			const result = await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: bytes.buffer as ArrayBuffer,
			});

			expect(result.success).toBe(true);
			expect(result.seq).toBe(1);
		});

		it("should increment sequence numbers", async () => {
			const bytes1 = new Uint8Array([1, 2, 3]);
			const bytes2 = new Uint8Array([4, 5, 6]);

			const result1 = await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: bytes1.buffer as ArrayBuffer,
			});

			const result2 = await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: bytes2.buffer as ArrayBuffer,
			});

			expect(result1.seq).toBe(1);
			expect(result2.seq).toBe(2);
		});
	});

	describe("updateDocument", () => {
		it("should update a document and increment sequence", async () => {
			const bytes = new Uint8Array([1, 2, 3, 4]);

			const result = await t.mutation(api.mutations.updateDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: bytes.buffer as ArrayBuffer,
			});

			expect(result.success).toBe(true);
			expect(result.seq).toBe(1);
		});
	});

	describe("scheduleCompaction", () => {
		it("should schedule compaction for a document", async () => {
			vi.useFakeTimers();

			// First insert some data
			await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
			});

			const result = await t.mutation(api.mutations.scheduleCompaction, {
				collection: "test-collection",
				document: "test-doc",
			});

			expect(result.status).toBe("scheduled");
			expect(result.id).toBeDefined();

			// Clean up scheduled functions
			vi.runAllTimers();
			await t.finishInProgressScheduledFunctions();
			vi.useRealTimers();
		});

		it("should not schedule duplicate compaction jobs", async () => {
			vi.useFakeTimers();

			// Insert data
			await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
			});

			// Schedule first compaction
			const result1 = await t.mutation(api.mutations.scheduleCompaction, {
				collection: "test-collection",
				document: "test-doc",
			});

			// Try to schedule second compaction
			const result2 = await t.mutation(api.mutations.scheduleCompaction, {
				collection: "test-collection",
				document: "test-doc",
			});

			expect(result1.status).toBe("scheduled");
			expect(result2.status).toBe("already_pending");

			// Clean up scheduled functions
			vi.runAllTimers();
			await t.finishInProgressScheduledFunctions();
			vi.useRealTimers();
		});
	});

	describe("runCompaction", () => {
		it("should compact deltas into snapshots", async () => {
			vi.useFakeTimers();

			// Helper to create valid Yjs update bytes
			const toArrayBuffer = (data: Uint8Array): ArrayBuffer =>
				data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

			// Insert multiple deltas with VALID Yjs updates (required for mergeUpdatesV2)
			const ydoc1 = new Y.Doc();
			ydoc1.getMap("fields").set("text", "first");

			await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(ydoc1)),
			});

			const ydoc2 = new Y.Doc();
			ydoc2.getMap("fields").set("text", "second");

			await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "test-doc",
				bytes: toArrayBuffer(Y.encodeStateAsUpdateV2(ydoc2)),
			});

			// Schedule and run compaction
			const scheduleResult = await t.mutation(api.mutations.scheduleCompaction, {
				collection: "test-collection",
				document: "test-doc",
			});

			const compactResult = await t.mutation(api.mutations.runCompaction, {
				id: scheduleResult.id!,
			});

			expect(compactResult).toEqual({
				removed: 2,
				retained: 0,
			});

			ydoc1.destroy();
			ydoc2.destroy();

			// Clean up scheduled functions
			vi.runAllTimers();
			await t.finishInProgressScheduledFunctions();
			vi.useRealTimers();
		});
	});

	describe("stream", () => {
		it("should return changes in sequence order", async () => {
			// Insert deltas
			await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "doc1",
				bytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
			});

			await t.mutation(api.mutations.insertDocument, {
				collection: "test-collection",
				document: "doc2",
				bytes: new Uint8Array([4, 5, 6]).buffer as ArrayBuffer,
			});

			const streamResult = await t.query(api.mutations.stream, {
				collection: "test-collection",
				seq: 0,
			});

			expect(streamResult.changes).toHaveLength(2);
			expect(streamResult.changes[0].document).toBe("doc1");
			expect(streamResult.changes[1].document).toBe("doc2");
			expect(streamResult.seq).toBe(2);
		});
	});
});
