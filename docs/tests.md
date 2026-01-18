# Test Suite Architecture

This document outlines the testing strategy for the Replicate sync library.

## Overview

Replicate requires testing across multiple layers:

| Layer         | Location         | What to Test                               |
| ------------- | ---------------- | ------------------------------------------ |
| **Component** | `src/component/` | Convex mutations, compaction, scheduling   |
| **Server**    | `src/server/`    | Replicate class, collection factory, hooks |
| **Client**    | `src/client/`    | Effect.ts actors, persistence, sync flow   |

## Test Categories & Environments

| Category         | Environment  | Purpose                           | Tools                   |
| ---------------- | ------------ | --------------------------------- | ----------------------- |
| **Unit**         | jsdom        | Actor logic, validators, Yjs ops  | Vitest + @effect/vitest |
| **Integration**  | jsdom        | Collection sync, offline→online   | fake-indexeddb + Yjs    |
| **E2E (Convex)** | edge-runtime | Component mutations, compaction   | convex-test             |
| **Browser**      | Playwright   | SQLite persistence, OPFS, Workers | @vitest/browser         |

## Dependencies

```bash
bun add -D convex-test @edge-runtime/vm @effect/vitest @vitest/browser playwright fake-indexeddb
```

## Directory Structure

```
src/test/
├── setup.ts                    # Shared setup (polyfills)
├── helpers/
│   ├── convex.ts              # convex-test wrappers
│   ├── effect.ts              # Effect + TestClock helpers
│   ├── yjs.ts                 # Y.Doc factories
│   └── persistence.ts         # Mock persistence
├── unit/                       # jsdom environment
│   ├── actor.test.ts          # DocumentActor (Effect.ts)
│   ├── manager.test.ts        # ActorManager
│   ├── merge.test.ts          # Yjs delta merging
│   └── validators.test.ts     # Schema validation
├── integration/                # jsdom + fake-indexeddb
│   ├── collection.test.ts     # Full sync cycle
│   └── offline.test.ts        # Offline → online
├── e2e/                        # edge-runtime (convex-test)
│   ├── mutations.test.ts      # insertDocument, etc.
│   ├── compaction.test.ts     # scheduleCompaction + runCompaction
│   └── presence.test.ts       # Sessions, mark, presence
└── browser/                    # @vitest/browser (Playwright)
    ├── sqlite.test.ts         # wa-sqlite + OPFS
    └── worker.test.ts         # Web Worker communication
```

## Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ["src/test/e2e/**", "edge-runtime"],
      ["src/test/browser/**", "browser"],
      ["src/test/unit/**", "jsdom"],
      ["src/test/integration/**", "jsdom"],
    ],
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/test/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    browser: {
      enabled: true,
      provider: "playwright",
      name: "chromium",
      headless: true,
    },
  },
  resolve: {
    alias: {
      $: resolve(__dirname, "./src"),
      "$/component": resolve(__dirname, "./src/component"),
    },
  },
});
```

## Testing Patterns

### 1. Convex Component Tests (convex-test)

Test mutations, queries, and scheduled functions:

```typescript
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "$/component/_generated/api";
import schema from "$/component/schema";

test("insertDocument creates delta with seq", async () => {
  const t = convexTest(schema);

  const result = await t.mutation(api.mutations.insertDocument, {
    collection: "tasks",
    document: "task-1",
    bytes: new Uint8Array([1, 2, 3]),
  });

  expect(result.success).toBe(true);
  expect(result.seq).toBe(1);
});
```

### 2. Testing Scheduled Functions

For `scheduleCompaction` and `runCompaction`:

```typescript
test("compaction job executes after scheduling", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);

  // Insert enough deltas to trigger threshold
  for (let i = 0; i < 500; i++) {
    await t.mutation(api.mutations.insertDocument, {
      collection: "test",
      document: "doc-1",
      bytes: new Uint8Array([i]),
    });
  }

  // Schedule compaction
  const result = await t.mutation(api.mutations.scheduleCompaction, {
    collection: "test",
    document: "doc-1",
  });

  expect(result.status).toBe("scheduled");

  // Trigger scheduled function
  vi.runAllTimers();
  await t.finishInProgressScheduledFunctions();

  // Verify job completed
  const job = await t.run(async (ctx) => {
    return await ctx.db.query("compaction")
      .withIndex("by_document", (q) =>
        q.eq("collection", "test").eq("document", "doc-1").eq("status", "done")
      )
      .first();
  });

  expect(job).not.toBeNull();
  vi.useRealTimers();
});
```

### 3. Testing Retry Logic

```typescript
test("runCompaction retries on failure", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema);

  // Create job with bad data that will fail
  const jobId = await t.run(async (ctx) => {
    return await ctx.db.insert("compaction", {
      collection: "test",
      document: "doc-1",
      status: "pending",
      started: Date.now(),
      retries: 0,
    });
  });

  // Run and expect retry
  vi.runAllTimers();
  await t.finishInProgressScheduledFunctions();

  const job = await t.run(async (ctx) => ctx.db.get(jobId));

  expect(job?.retries).toBeGreaterThan(0);
  vi.useRealTimers();
});
```

### 4. Effect.ts Actor Tests

Using `@effect/vitest` with `TestClock`:

```typescript
import { it, describe } from "@effect/vitest";
import { Effect, TestClock, SubscriptionRef } from "effect";

describe("DocumentActor", () => {
  it.scoped("batches rapid local changes into single sync", () =>
    Effect.gen(function* () {
      const mockSync = createMockSyncFn();
      const actor = yield* createDocumentActor("doc1", mockSync.fn);

      // Send rapid changes
      for (let i = 0; i < 5; i++) {
        yield* actor.send({ _tag: "LocalChange" });
      }

      // Verify pending
      expect(yield* SubscriptionRef.get(actor.pending)).toBe(true);

      // Advance past debounce (200ms)
      yield* TestClock.adjust("250 millis");
      yield* Effect.sleep("10 millis");

      // Should batch into single sync call
      expect(mockSync.getCallCount()).toBe(1);
    })
  );

  it.scoped("retries with exponential backoff", () =>
    Effect.gen(function* () {
      const mockSync = createMockSyncFn({ failCount: 2 });
      const actor = yield* createDocumentActor("doc1", mockSync.fn);

      yield* actor.send({ _tag: "LocalChange" });
      yield* TestClock.adjust("500 millis");
      yield* Effect.sleep("10 millis");

      // Should retry and succeed on 3rd attempt
      expect(mockSync.getCallCount()).toBe(3);
    })
  );
});
```

### 5. Yjs CRDT Tests

```typescript
import * as Y from "yjs";

test("merges concurrent inserts", () => {
  const doc1 = new Y.Doc();
  const doc2 = new Y.Doc();

  const array1 = doc1.getArray("items");
  const array2 = doc2.getArray("items");

  // Concurrent inserts
  array1.insert(0, ["A"]);
  array2.insert(0, ["B"]);

  // Merge
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

  expect(array2.toArray()).toContain("A");
  expect(array2.toArray()).toContain("B");
});

test("extracts prose text", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("content");

  // Insert text
  const text = new Y.XmlText();
  text.insert(0, "Hello world");
  fragment.insert(0, [text]);

  const extracted = schema.prose.extract(fragment.toJSON());
  expect(extracted).toBe("Hello world");
});
```

### 6. Browser Persistence Tests

```typescript
// @vitest-environment browser

import { persistence } from "$/client/persistence";

describe("SQLite Persistence", () => {
  let db: Awaited<ReturnType<typeof persistence.web.sqlite>>;

  beforeEach(async () => {
    db = await persistence.web.sqlite({
      name: `test-${crypto.randomUUID()}`,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  test("persists and retrieves data", async () => {
    await db.kv.set("key", new Uint8Array([1, 2, 3]));
    const result = await db.kv.get("key");

    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("uses OPFS via wa-sqlite", async () => {
    // OPFS is automatically used when available
    const estimate = await navigator.storage.estimate();
    expect(estimate.quota).toBeGreaterThan(0);
  });
});
```

## Test Helpers

### Convex Test Helper

```typescript
// src/test/helpers/convex.ts
import { convexTest } from "convex-test";
import schema from "$/component/schema";

export const createTestContext = () => convexTest(schema);

export const insertTestDeltas = async (
  t: ReturnType<typeof convexTest>,
  collection: string,
  document: string,
  count: number
) => {
  for (let i = 0; i < count; i++) {
    await t.mutation(api.mutations.insertDocument, {
      collection,
      document,
      bytes: new Uint8Array([i % 256]),
    });
  }
};
```

### Effect Test Helper

```typescript
// src/test/helpers/effect.ts
import { it, describe } from "@effect/vitest";
import { Effect, TestClock, Queue, Deferred, Ref, SubscriptionRef } from "effect";
import * as Y from "yjs";

export { it, describe, Effect, TestClock, Queue, Deferred, Ref, SubscriptionRef };

export const createTestYDoc = (fields: Record<string, unknown> = {}) => {
  const doc = new Y.Doc();
  const map = doc.getMap("fields");
  Object.entries(fields).forEach(([k, v]) => map.set(k, v));
  return doc;
};

export const createMockSyncFn = (opts: { failCount?: number } = {}) => {
  let callCount = 0;
  const { failCount = 0 } = opts;

  return {
    fn: async () => {
      callCount++;
      if (callCount <= failCount) {
        throw new Error(`Sync failed (attempt ${callCount})`);
      }
    },
    getCallCount: () => callCount,
  };
};
```

### Yjs Test Helper

```typescript
// src/test/helpers/yjs.ts
import * as Y from "yjs";

export const createDelta = (doc: Y.Doc): Uint8Array => {
  return Y.encodeStateAsUpdateV2(doc);
};

export const applyDelta = (doc: Y.Doc, delta: Uint8Array): void => {
  Y.applyUpdateV2(doc, delta);
};

export const createDocWithFields = (fields: Record<string, unknown>): Y.Doc => {
  const doc = new Y.Doc();
  const map = doc.getMap("fields");
  for (const [key, value] of Object.entries(fields)) {
    map.set(key, value);
  }
  return doc;
};
```

## Test Priority

1. **Component mutations** - Core CRDT storage
   - `insertDocument`, `updateDocument`, `deleteDocument`
   - Delta creation with seq numbers
2. **Compaction flow** - Job scheduling and execution
   - `scheduleCompaction` deduplication
   - `runCompaction` with retries
   - Peer-aware delta deletion
3. **Effect actors** - Sync management
   - Queue batching
   - Debounce timing
   - Retry with exponential backoff
4. **Collection sync** - End-to-end flow
   - Client → server → other clients
   - Offline accumulation → online sync
5. **Browser persistence** - Real browser APIs
   - wa-sqlite + OPFS
   - Web Worker communication

## Running Tests

```bash
# Run all tests
bun run test

# Run specific category
bun run test src/test/unit
bun run test src/test/e2e
bun run test src/test/browser

# Watch mode
bun run test:watch

# Coverage
bun run test --coverage
```

## CI Configuration

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build
      - run: bun run test

  browser-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bunx playwright install chromium
      - run: bun run test src/test/browser
```

## Writing Deep Integration Tests

### What Makes a Test "Deep"

A deep test exercises **real behavior** through the full stack. Shallow tests mock everything and test implementation details.

**Examples of shallow tests to avoid:**

```typescript
// AVOID: Testing implementation details
test("insertDocument returns seq", async () => {
  const result = await mutation(insertDocument, { ... });
  expect(result.seq).toBe(1); // Trivial, tests implementation
});

// AVOID: Testing that mock was called
test("calls db.insert", async () => {
  await mutation(insertDocument, { ... });
  expect(mockDB.insert).toHaveBeenCalled(); // Tests nothing useful
});

// AVOID: Testing getters
test("getCollection returns collection", () => {
  const collection = createCollection("tasks");
  expect(collection.name).toBe("tasks"); // Trivial
});
```

**Examples of deep tests to write:**

```typescript
// GOOD: Tests actual behavior - delta exists with correct seq
test("insertDocument persists delta with incremental seq number", async () => {
  const t = convexTest(schema);

  // First insert
  await t.mutation(api.mutations.insertDocument, {
    collection: "tasks",
    document: "task-1",
    bytes: encodeDelta({ text: "first" }),
  });

  // Second insert - should have seq=2
  await t.mutation(api.mutations.insertDocument, {
    collection: "tasks",
    document: "task-1",
    bytes: encodeDelta({ text: "second" }),
  });

  // Verify both deltas exist with correct seq numbers
  const deltas = await t.run(async (ctx) => {
    return await ctx.db.query("deltas")
      .withIndex("by_document", (q) =>
        q.eq("collection", "tasks").eq("document", "task-1")
      )
      .collect();
  });

  expect(deltas).toHaveLength(2);
  expect(deltas[0].seq).toBe(1);
  expect(deltas[1].seq).toBe(2);
});

// GOOD: Tests compaction respects active peers
test("runCompaction retains deltas when peer needs data", async () => {
  const t = convexTest(schema);

  // Create delta
  await t.mutation(api.mutations.insertDocument, {
    collection: "test",
    document: "doc-1",
    bytes: encodeDelta({ text: "data" }),
  });

  // Add active peer with old vector
  await t.mutation(api.mutations.presence, {
    collection: "test",
    document: "doc-1",
    client: "peer-1",
    action: "join",
    vector: encodeOldVector(), // Missing latest delta
  });

  // Run compaction - should retain deltas for active peer
  const result = await t.mutation(api.mutations.runCompaction, {
    id: "job-1",
  });

  expect(result).toMatchObject({
    removed: 0, // Can't delete - peer still needs it
    retained: expect.any(Number),
  });

  // Verify delta still exists
  const deltas = await t.run(async (ctx) => {
    return await ctx.db.query("deltas")
      .withIndex("by_document", (q) =>
        q.eq("collection", "test").eq("document", "doc-1")
      )
      .collect();
  });

  expect(deltas.length).toBeGreaterThan(0);
});

// GOOD: Tests full sync cycle
test("client sends delta → server stores → other client receives", async () => {
  const alice = convexTest(schema);
  const bob = convexTest(schema);

  // Alice sends delta
  await alice.mutation(api.mutations.insertDocument, {
    collection: "notes",
    document: "note-1",
    bytes: encodeDelta({ text: "from alice" }),
  });

  // Bob streams and receives
  const stream = await bob.query(api.mutations.stream, {
    collection: "notes",
    seq: 0,
  });

  expect(stream.changes).toHaveLength(1);

  // Verify Bob received Alice's change
  const merged = applyDelta(stream.changes[0].bytes);
  expect(merged.text).toBe("from alice");
});

// GOOD: Tests actor batching behavior
test("actor batches 5 rapid changes into single sync call", async () => {
  const ydoc = createTestYDoc();
  const mockSync = createMockSyncFn();

  const actor = await createDocumentActor("doc1", ydoc, mockSync.fn);

  // Trigger 5 rapid changes (all within debounce window)
  for (let i = 0; i < 5; i++) {
    actor.handleLocalChange({ type: "insert", data: { id: i } });
  }

  // Advance past debounce
  yield* TestClock.adjust("250 millis");

  // Verify single sync call with all 5 changes
  expect(mockSync.getCallCount()).toBe(1);
  const sentData = mockSync.fn.mock.calls[0][0];
  expect(sentData).toHaveLength(5);
});
```

### Test Review Checklist

When reviewing a test before committing, verify:

- [ ] **Tests behavior, not implementation** - "What happens when..." not "Does this function call..."
- [ ] **No mocks for the thing being tested** - If testing persistence, use real persistence
- [ ] **Tests error cases with real failures** - Don't `vi.fn()` to throw, test with bad data
- [ ] **Tests invariants** - "Sequence numbers always increment", not "Function increments counter"
- [ ] **Has observable effect** - Can I see the result in DB/state/sync?
- [ ] **Multiple steps = one test** - Test flows, not individual function calls

### What NOT to Test

Don't write tests for:

1. **Trivial getters/setters** - `expect(collection.name).toBe("tasks")`
2. **Function existence** - `expect(typeof insertDocument).toBe("function")`
3. **Mock call counts** - `expect(mock.insert).toHaveBeenCalledTimes(1)` (unless testing retry logic)
4. **String matching** - `expect(result.message).toContain("error")` (error messages change)
5. **Type coercion** - `expect(String(123)).toBe("123")`

### Minimum Test Count by Category

Rather than writing 100+ trivial tests, aim for:

| Category                | Target Count | Focus                                           |
| ----------------------- | ------------ | ----------------------------------------------- |
| **Component mutations** | 5-8 tests    | Seq numbers, peer awareness, compaction trigger |
| **Compaction flow**     | 3-5 tests    | Scheduling, retry, peer safety, retain logic    |
| **Effect actors**       | 4-6 tests    | Batching, debounce, retry, shutdown cleanup     |
| **Integration sync**    | 3-5 tests    | Full client→server→client cycle, offline→online |
| **Browser persistence** | 2-4 tests    | SQLite write/read, OPFS access                  |

**Total: ~17-28 deep tests** (not 50+ shallow ones)

## Limitations

### convex-test

- No cron job support (trigger manually)
- Error messages may differ from production
- No limits enforcement (size/time)
- Simplified text/vector search

### Browser Mode

- Requires Playwright/WebDriver installation
- Slower than jsdom tests
- CI needs browser binaries

### Effect TestClock

- Only works with Effect-managed time
- Real timers need `vi.useFakeTimers()`
