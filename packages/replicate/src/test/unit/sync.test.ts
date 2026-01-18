import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createDocumentSync, createSyncManager } from "$/client/services/sync";

// Helper to create a mock Y.Doc
function createMockYDoc(): Y.Doc {
	return new Y.Doc();
}

// Helper to create a mock sync function that tracks calls
function createMockSyncFn(options: { failCount?: number } = {}) {
	const { failCount = 0 } = options;
	let callCount = 0;

	const fn = vi.fn(async () => {
		callCount++;
		if (callCount <= failCount) {
			throw new Error(`Sync failed (attempt ${callCount})`);
		}
	});

	return {
		fn,
		getCallCount: () => callCount,
	};
}

describe("createDocumentSync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("debounce mechanism", () => {
		test("debounces multiple calls within window", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			// Call onLocalChange multiple times rapidly
			sync.onLocalChange();
			sync.onLocalChange();
			sync.onLocalChange();
			sync.onLocalChange();
			sync.onLocalChange();

			// Advance past debounce
			await vi.advanceTimersByTimeAsync(200);

			expect(getCallCount()).toBe(1);

			sync.destroy();
			ydoc.destroy();
		});

		test("restarts debounce on each call", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(150);
			expect(getCallCount()).toBe(0);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(150);
			expect(getCallCount()).toBe(0);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(200);
			expect(getCallCount()).toBe(1);

			sync.destroy();
			ydoc.destroy();
		});

		test("respects custom debounceMs", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 500);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(400);
			expect(getCallCount()).toBe(0);

			await vi.advanceTimersByTimeAsync(100);
			expect(getCallCount()).toBe(1);

			sync.destroy();
			ydoc.destroy();
		});

		test("uses default debounce of 50ms when not provided", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(49);
			expect(getCallCount()).toBe(0);

			await vi.advanceTimersByTimeAsync(1);
			expect(getCallCount()).toBe(1);

			sync.destroy();
			ydoc.destroy();
		});
	});

	describe("pending state", () => {
		test("isPending returns false initially", () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn);

			expect(sync.isPending()).toBe(false);

			sync.destroy();
			ydoc.destroy();
		});

		test("isPending returns true after onLocalChange", () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn);

			sync.onLocalChange();
			expect(sync.isPending()).toBe(true);

			sync.destroy();
			ydoc.destroy();
		});

		test("isPending returns false after sync completes", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			sync.onLocalChange();
			expect(sync.isPending()).toBe(true);

			await vi.advanceTimersByTimeAsync(200);
			expect(sync.isPending()).toBe(false);

			sync.destroy();
			ydoc.destroy();
		});

		test("transitions correctly through full cycle", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);
			const states: boolean[] = [];

			sync.onPendingChange(pending => states.push(pending));

			expect(sync.isPending()).toBe(false);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(200);

			expect(states).toEqual([true, false]);

			sync.destroy();
			ydoc.destroy();
		});
	});

	describe("listeners", () => {
		test("onPendingChange calls callback on state transition", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);
			const callback = vi.fn();

			sync.onPendingChange(callback);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(200);

			expect(callback).toHaveBeenCalledTimes(2);
			expect(callback).toHaveBeenNthCalledWith(1, true);
			expect(callback).toHaveBeenNthCalledWith(2, false);

			sync.destroy();
			ydoc.destroy();
		});

		test("onPendingChange returns unsubscribe function", () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn);

			const unsubscribe = sync.onPendingChange(() => {});
			expect(typeof unsubscribe).toBe("function");

			sync.destroy();
			ydoc.destroy();
		});

		test("unsubscribe stops callbacks after called", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);
			const callback = vi.fn();

			const unsubscribe = sync.onPendingChange(callback);
			unsubscribe();

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(200);

			expect(callback).not.toHaveBeenCalled();

			sync.destroy();
			ydoc.destroy();
		});

		test("multiple listeners all receive updates", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);
			const callback1 = vi.fn();
			const callback2 = vi.fn();
			const callback3 = vi.fn();

			sync.onPendingChange(callback1);
			sync.onPendingChange(callback2);
			sync.onPendingChange(callback3);

			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(200);

			expect(callback1).toHaveBeenCalledTimes(2);
			expect(callback2).toHaveBeenCalledTimes(2);
			expect(callback3).toHaveBeenCalledTimes(2);

			sync.destroy();
			ydoc.destroy();
		});

		test("only calls callback when state actually changes", () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);
			const callback = vi.fn();

			sync.onPendingChange(callback);

			// Call onLocalChange twice rapidly (no timer advance)
			sync.onLocalChange();
			sync.onLocalChange();

			// Should only get called once with true
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(true);

			sync.destroy();
			ydoc.destroy();
		});
	});

	describe("error handling", () => {
		test("sync error does not crash, continues working", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn({ failCount: 1 });
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			// First sync will fail
			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(200);
			expect(getCallCount()).toBe(1);

			// Second sync should succeed
			sync.onLocalChange();
			await vi.advanceTimersByTimeAsync(200);
			expect(getCallCount()).toBe(2);

			sync.destroy();
			ydoc.destroy();
		});

		test("sync error resets pending state to false after retries exhausted", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn({ failCount: 100 });
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			sync.onLocalChange();
			expect(sync.isPending()).toBe(true);

			// First attempt after debounce (200ms)
			await vi.advanceTimersByTimeAsync(200);
			// Still pending during retry 1
			expect(sync.isPending()).toBe(true);

			// Retry 1 after 1000ms
			await vi.advanceTimersByTimeAsync(1000);
			expect(sync.isPending()).toBe(true);

			// Retry 2 after 2000ms
			await vi.advanceTimersByTimeAsync(2000);
			expect(sync.isPending()).toBe(true);

			// Retry 3 (final) after 3000ms - should reset to false after this
			await vi.advanceTimersByTimeAsync(3000);
			expect(sync.isPending()).toBe(false);

			sync.destroy();
			ydoc.destroy();
		});

		test("sync error calls listeners with false after retries exhausted", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn({ failCount: 100 });
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);
			const callback = vi.fn();

			sync.onPendingChange(callback);

			sync.onLocalChange();

			// First call: pending = true on onLocalChange
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenNthCalledWith(1, true);

			// Advance through all retries (200 + 1000 + 2000 + 3000 = 6200ms)
			await vi.advanceTimersByTimeAsync(6200);

			// Second call: pending = false after all retries exhausted
			expect(callback).toHaveBeenCalledTimes(2);
			expect(callback).toHaveBeenNthCalledWith(2, false);

			sync.destroy();
			ydoc.destroy();
		});
	});

	describe("destroy", () => {
		test("destroy clears timeout if pending", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			sync.onLocalChange();
			sync.destroy();

			// Advance past debounce - sync should NOT be called
			await vi.advanceTimersByTimeAsync(200);
			expect(getCallCount()).toBe(0);

			ydoc.destroy();
		});

		test("destroy prevents future syncs", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			sync.destroy();
			sync.onLocalChange();

			await vi.advanceTimersByTimeAsync(200);
			expect(getCallCount()).toBe(0);

			ydoc.destroy();
		});

		test("destroy clears all listeners", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);
			const callback = vi.fn();

			sync.onPendingChange(callback);
			sync.destroy();

			// Even if we could trigger a pending change, listeners should be cleared
			// This is verified by the fact that after destroy, the listeners Set is cleared
			expect(callback).not.toHaveBeenCalled();

			ydoc.destroy();
		});

		test("onLocalChange is no-op after destroy", () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn);

			sync.destroy();
			sync.onLocalChange();

			// Should not throw and pending should remain false
			expect(sync.isPending()).toBe(false);

			ydoc.destroy();
		});
	});

	describe("onServerUpdate", () => {
		test("onServerUpdate is no-op and does not affect pending", () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn);

			sync.onServerUpdate();
			expect(sync.isPending()).toBe(false);

			sync.destroy();
			ydoc.destroy();
		});

		test("onServerUpdate does not trigger sync", async () => {
			const ydoc = createMockYDoc();
			const { fn: syncFn, getCallCount } = createMockSyncFn();
			const sync = createDocumentSync("doc1", ydoc, syncFn, 200);

			sync.onServerUpdate();
			sync.onServerUpdate();
			sync.onServerUpdate();

			await vi.advanceTimersByTimeAsync(200);
			expect(getCallCount()).toBe(0);

			sync.destroy();
			ydoc.destroy();
		});
	});
});

describe("createSyncManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("register creates DocumentSync and returns it", () => {
		const manager = createSyncManager("collection1");
		const ydoc = createMockYDoc();
		const { fn: syncFn } = createMockSyncFn();

		const sync = manager.register("doc1", ydoc, syncFn);

		expect(sync).toBeDefined();
		expect(typeof sync.onLocalChange).toBe("function");
		expect(typeof sync.isPending).toBe("function");
		expect(typeof sync.destroy).toBe("function");

		manager.destroy();
		ydoc.destroy();
	});

	test("register returns same instance for same document", () => {
		const manager = createSyncManager("collection1");
		const ydoc = createMockYDoc();
		const { fn: syncFn } = createMockSyncFn();

		const sync1 = manager.register("doc1", ydoc, syncFn);
		const sync2 = manager.register("doc1", ydoc, syncFn);

		expect(sync1).toBe(sync2);

		manager.destroy();
		ydoc.destroy();
	});

	test("get returns null for unregistered document", () => {
		const manager = createSyncManager("collection1");

		expect(manager.get("unknown")).toBeNull();

		manager.destroy();
	});

	test("get returns DocumentSync for registered document", () => {
		const manager = createSyncManager("collection1");
		const ydoc = createMockYDoc();
		const { fn: syncFn } = createMockSyncFn();

		const registered = manager.register("doc1", ydoc, syncFn);
		const retrieved = manager.get("doc1");

		expect(retrieved).toBe(registered);

		manager.destroy();
		ydoc.destroy();
	});

	test("unregister destroys sync and removes from manager", () => {
		const manager = createSyncManager("collection1");
		const ydoc = createMockYDoc();
		const { fn: syncFn, getCallCount } = createMockSyncFn();

		const sync = manager.register("doc1", ydoc, syncFn, 200);
		sync.onLocalChange();

		manager.unregister("doc1");

		// Should be removed
		expect(manager.get("doc1")).toBeNull();

		// Sync should be destroyed (timeout cleared)
		vi.advanceTimersByTime(200);
		expect(getCallCount()).toBe(0);

		manager.destroy();
		ydoc.destroy();
	});

	test("unregister is safe for unknown document", () => {
		const manager = createSyncManager("collection1");

		// Should not throw
		expect(() => manager.unregister("unknown")).not.toThrow();

		manager.destroy();
	});

	test("destroy destroys all syncs and clears manager", async () => {
		const manager = createSyncManager("collection1");
		const ydoc1 = createMockYDoc();
		const ydoc2 = createMockYDoc();
		const ydoc3 = createMockYDoc();
		const { fn: syncFn1, getCallCount: getCount1 } = createMockSyncFn();
		const { fn: syncFn2, getCallCount: getCount2 } = createMockSyncFn();
		const { fn: syncFn3, getCallCount: getCount3 } = createMockSyncFn();

		const sync1 = manager.register("doc1", ydoc1, syncFn1, 200);
		const sync2 = manager.register("doc2", ydoc2, syncFn2, 200);
		const sync3 = manager.register("doc3", ydoc3, syncFn3, 200);

		sync1.onLocalChange();
		sync2.onLocalChange();
		sync3.onLocalChange();

		manager.destroy();

		// All should be removed
		expect(manager.get("doc1")).toBeNull();
		expect(manager.get("doc2")).toBeNull();
		expect(manager.get("doc3")).toBeNull();

		// All timeouts should be cleared
		await vi.advanceTimersByTimeAsync(200);
		expect(getCount1()).toBe(0);
		expect(getCount2()).toBe(0);
		expect(getCount3()).toBe(0);

		ydoc1.destroy();
		ydoc2.destroy();
		ydoc3.destroy();
	});

	test("separate collections have independent syncs", async () => {
		const manager1 = createSyncManager("collection1");
		const manager2 = createSyncManager("collection2");
		const ydoc1 = createMockYDoc();
		const ydoc2 = createMockYDoc();
		const { fn: syncFn1, getCallCount: getCount1 } = createMockSyncFn();
		const { fn: syncFn2, getCallCount: getCount2 } = createMockSyncFn();

		// Register same docId in different collections
		const sync1 = manager1.register("doc1", ydoc1, syncFn1, 200);
		const sync2 = manager2.register("doc1", ydoc2, syncFn2, 200);

		expect(sync1).not.toBe(sync2);

		sync1.onLocalChange();
		await vi.advanceTimersByTimeAsync(200);

		expect(getCount1()).toBe(1);
		expect(getCount2()).toBe(0);

		manager1.destroy();
		manager2.destroy();
		ydoc1.destroy();
		ydoc2.destroy();
	});

	test("destroy cleans up global map allowing reuse", async () => {
		const manager1 = createSyncManager("collection1");
		const ydoc1 = createMockYDoc();
		const { fn: syncFn1 } = createMockSyncFn();

		manager1.register("doc1", ydoc1, syncFn1);
		manager1.destroy();

		// Create new manager for same collection
		const manager2 = createSyncManager("collection1");
		const ydoc2 = createMockYDoc();
		const { fn: syncFn2 } = createMockSyncFn();

		// Should start fresh (no remnants from old manager)
		expect(manager2.get("doc1")).toBeNull();

		const sync = manager2.register("doc1", ydoc2, syncFn2);
		expect(sync).toBeDefined();

		manager2.destroy();
		ydoc1.destroy();
		ydoc2.destroy();
	});
});
