# Performance Optimization & Partial Sync

## Status: Next Phase

Building on the presence branch foundation, this document outlines strategies for optimizing Replicate performance at scale.

## Core Principle: Correctness First

**We never sacrifice CRDT history for performance.** All optimizations must preserve:

- Full operation history for offline clients
- State vectors for conflict resolution
- Ability to sync with any client regardless of when they last connected

---

## Goals

1. **Fast initial load** - Sub-second time-to-interactive for large collections
2. **Efficient sync** - Minimize bandwidth and compute for ongoing updates
3. **Scalable architecture** - Support 10K+ documents per collection
4. **Parallel processing** - Maximize throughput without conflicts

---

## Safe vs Unsafe Optimizations

### ✅ Safe (Preserve CRDT History)

| Technique               | Size Reduction | Description                             |
| ----------------------- | -------------- | --------------------------------------- |
| `Y.mergeUpdates()`      | ~61%           | Combines updates, keeps all operations  |
| State vector diffing    | Variable       | Only transfer missing ops               |
| Batch network calls     | N/A            | Reduce round trips                      |
| Parallel doc processing | N/A            | Different docs don't conflict           |
| Indexed queries         | N/A            | Faster DB reads                         |
| Compaction (current)    | ~70%           | Merge deltas into snapshot in component |

### ❌ Unsafe (Never Do)

| Technique                 | Why Dangerous                           |
| ------------------------- | --------------------------------------- |
| Fresh doc from snapshot   | Loses CRDT history, breaks offline sync |
| Truncating old operations | Offline clients can't merge             |
| Discarding tombstones     | Deleted items may reappear              |

---

## 0. Critical: Fire-and-Forget Mutations with Retry

### The Problem

Current implementation blocks on server sync and rolls back on error:

```typescript
// ❌ BAD: Blocks UI, rolls back local state on server error
onInsert: async ({ transaction }) => {
  const deltas = applyYjsInsert(transaction.mutations);
  try {
    await persistenceReadyPromise;
    for (const mut of transaction.mutations) {
      await convexClient.mutation(api.insert, { ... }); // Sequential, blocking
    }
  } catch (error) {
    handleMutationError(error); // Throws -> TanStack DB rolls back
  }
}
```

When clicking rapidly:

- First ~10 succeed before rate limiting
- Remaining hit OCC conflicts/rate limits
- Those transactions get rolled back, **items disappear from UI**

### The Fix: Fire-and-Forget with Retry Queue

Local CRDT state is the source of truth. Server sync is just replication.

```typescript
// ✅ GOOD: Non-blocking, parallel, with retry
onInsert: async ({ transaction }) => {
  // 1. Apply to local Yjs immediately (synchronous)
  const deltas = applyYjsInsert(transaction.mutations);

  // 2. Fire-and-forget server sync - don't await, don't throw
  Promise.all([persistenceReadyPromise, optimisticReadyPromise])
    .then(() => {
      // 3. Parallel mutations for all documents
      return Promise.all(
        transaction.mutations.map(async (mut, i) => {
          const delta = deltas[i];
          if (!delta || delta.length === 0) return;

          const document = String(mut.key);
          await syncWithRetry("insert", document, delta, mut.modified);
        })
      );
    })
    .catch((error) => {
      logger.error`Insert sync failed: ${error}`;
    });

  // 4. Return immediately - local state is already applied
}
```

### Retry Queue Implementation

```typescript
interface RetryItem {
  type: "insert" | "update" | "delete";
  document: string;
  delta: Uint8Array;
  material?: unknown;
  attempts: number;
  nextRetry: number;
}

class RetryQueue {
  private queue: RetryItem[] = [];
  private processing = false;
  private maxAttempts = 5;
  private baseDelay = 1000;

  async enqueue(item: Omit<RetryItem, "attempts" | "nextRetry">) {
    this.queue.push({
      ...item,
      attempts: 0,
      nextRetry: Date.now(),
    });
    this.process();
  }

  private async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const ready = this.queue.filter(item => item.nextRetry <= now);

      if (ready.length === 0) {
        // Wait for next item
        const nextTime = Math.min(...this.queue.map(i => i.nextRetry));
        await sleep(nextTime - now);
        continue;
      }

      // Process ready items in parallel
      await Promise.all(ready.map(async (item) => {
        try {
          await this.executeMutation(item);
          // Success - remove from queue
          this.queue = this.queue.filter(i => i !== item);
        } catch (error) {
          item.attempts++;
          if (item.attempts >= this.maxAttempts) {
            logger.error`Max retries exceeded for ${item.document}`;
            this.queue = this.queue.filter(i => i !== item);
          } else {
            // Exponential backoff with jitter
            const delay = this.baseDelay * Math.pow(2, item.attempts);
            const jitter = delay * 0.2 * Math.random();
            item.nextRetry = Date.now() + delay + jitter;
          }
        }
      }));
    }

    this.processing = false;
  }

  private async executeMutation(item: RetryItem) {
    switch (item.type) {
      case "insert":
        await convexClient.mutation(api.insert, {
          document: item.document,
          bytes: item.delta.buffer,
          material: item.material,
        });
        break;
      case "update":
        await convexClient.mutation(api.update, {
          document: item.document,
          bytes: item.delta.buffer,
          material: item.material,
        });
        break;
      case "delete":
        await convexClient.mutation(api.remove, {
          document: item.document,
          bytes: item.delta.buffer,
        });
        break;
    }
  }
}

const retryQueue = new RetryQueue();

async function syncWithRetry(
  type: "insert" | "update" | "delete",
  document: string,
  delta: Uint8Array,
  material?: unknown
) {
  try {
    // First attempt
    await executeMutation({ type, document, delta, material });
  } catch (error) {
    // Queue for retry
    retryQueue.enqueue({ type, document, delta, material });
  }
}
```

### Apply to All Handlers

```typescript
// onInsert - parallel, fire-and-forget, with retry
onInsert: async ({ transaction }) => {
  const deltas = applyYjsInsert(transaction.mutations);

  Promise.all([persistenceReadyPromise, optimisticReadyPromise])
    .then(() => Promise.all(
      transaction.mutations.map((mut, i) => {
        const delta = deltas[i];
        if (!delta?.length) return;
        return syncWithRetry("insert", String(mut.key), delta,
          extractDocumentFromSubdoc(subdocManager, String(mut.key)) ?? mut.modified);
      })
    ))
    .catch(e => logger.error`Insert sync error: ${e}`);
}

// onUpdate - parallel, fire-and-forget, with retry
onUpdate: async ({ transaction }) => {
  const deltas = applyYjsUpdate(transaction.mutations);

  Promise.all([persistenceReadyPromise, optimisticReadyPromise])
    .then(() => Promise.all(
      transaction.mutations.map((mut, i) => {
        const delta = deltas[i];
        if (!delta?.length) return;
        return syncWithRetry("update", String(mut.key), delta,
          extractDocumentFromSubdoc(subdocManager, String(mut.key)) ?? mut.modified);
      })
    ))
    .catch(e => logger.error`Update sync error: ${e}`);
}

// onDelete - parallel, fire-and-forget, with retry
onDelete: async ({ transaction }) => {
  const deltas = applyYjsDelete(transaction.mutations);
  ops.delete(transaction.mutations.map(m => m.original).filter(Boolean));

  Promise.all([persistenceReadyPromise, optimisticReadyPromise])
    .then(() => Promise.all(
      transaction.mutations.map((mut, i) => {
        const delta = deltas[i];
        if (!delta?.length) return;
        return syncWithRetry("delete", String(mut.key), delta);
      })
    ))
    .catch(e => logger.error`Delete sync error: ${e}`);
}
```

### Why This Works

1. **Instant UI**: Local Yjs state applied synchronously
2. **No rollbacks**: TanStack DB never sees errors (we don't throw)
3. **Persistent**: Yjs subdocs saved to IndexedDB/SQLite
4. **Resilient**: Failed mutations retry with exponential backoff
5. **Parallel**: All documents sync concurrently via Promise.all
6. **Eventually consistent**: Recovery query syncs any missed data

---

## 1. Batch Operations

### 1.1 Batch Mutations (Convex)

Convex automatically batches mutations within a single function as an atomic transaction:

```typescript
export const batchSync = mutation({
  args: {
    documents: v.array(v.object({
      id: v.string(),
      bytes: v.bytes(),
      seq: v.number(),
    }))
  },
  handler: async (ctx, { documents }) => {
    for (const doc of documents) {
      await ctx.db.insert("deltas", { ...doc });
    }
  },
});
```

### 1.2 Client-Side Batching

Debounce rapid updates and batch them:

```typescript
class SyncBatcher {
  private pending = new Map<string, Uint8Array>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  add(document: string, delta: Uint8Array) {
    // Merge with pending delta for same document
    const existing = this.pending.get(document);
    if (existing) {
      this.pending.set(document, Y.mergeUpdates([existing, delta]));
    } else {
      this.pending.set(document, delta);
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  private async flush() {
    this.flushTimer = null;
    const batch = Array.from(this.pending.entries()).map(([id, bytes]) => ({
      id,
      bytes,
    }));
    this.pending.clear();

    if (batch.length > 0) {
      await convexClient.mutation(api.sync.batchSync, { documents: batch });
    }
  }
}
```

### 1.3 Batch SSR Hydration

Fetch multiple collections in parallel during SSR:

```typescript
// Server: Parallel prefetch
export async function loader() {
  const [intervals, comments] = await Promise.all([
    httpClient.query(api.intervals.material),
    httpClient.query(api.comments.material),
  ]);
  return { intervals, comments };
}

// Client: Parallel init with single render
await Promise.all([
  intervals.init(loaderData.intervals),
  comments.init(loaderData.comments),
]);
```

---

## 2. Parallel CRDT Resolution

### 2.1 Document-Level Parallelism

CRDTs are independent per document - process them concurrently:

```typescript
async function applyBatchUpdates(updates: Array<{doc: string, bytes: ArrayBuffer}>) {
  // Group by document to merge updates for same doc
  const byDoc = new Map<string, Uint8Array[]>();
  for (const { doc, bytes } of updates) {
    const existing = byDoc.get(doc) || [];
    existing.push(new Uint8Array(bytes));
    byDoc.set(doc, existing);
  }

  // Process documents in parallel
  await Promise.all(
    Array.from(byDoc.entries()).map(async ([doc, docUpdates]) => {
      // Merge all updates for this document first
      const merged = Y.mergeUpdates(docUpdates);
      subdocManager.applyUpdate(doc, merged, "server");

      const item = extractDocumentFromSubdoc(subdocManager, doc);
      if (item) ops.upsert([item]);
    })
  );
}
```

### 2.2 Convex OCC-Friendly Writes

Partition writes by document to avoid OCC conflicts:

```typescript
// ❌ Bad: Reading entire table causes conflicts with any insert
export const writeCount = mutation({
  handler: async (ctx) => {
    const all = await ctx.db.query("deltas").collect(); // Conflicts!
    // ...
  },
});

// ✅ Good: Query by document index - only conflicts with same document
export const applyDelta = mutation({
  args: { document: v.string(), bytes: v.bytes() },
  handler: async (ctx, { document, bytes }) => {
    const existing = await ctx.db.query("deltas")
      .withIndex("by_document", q => q.eq("document", document))
      .collect(); // Only conflicts with same document
    // ...
  },
});
```

### 2.3 Workpool for High-Throughput

Use Convex Workpool when many documents update simultaneously:

```typescript
import { Workpool } from "@convex-dev/workpool";

const syncPool = new Workpool(components.syncWorkpool, {
  maxParallelism: 10,
});

export const processBatch = action({
  args: { documents: v.array(v.object({ id: v.string(), bytes: v.bytes() })) },
  handler: async (ctx, { documents }) => {
    await syncPool.enqueueMutationBatch(
      ctx,
      internal.sync.applyDelta,
      documents
    );
  },
});
```

---

## 3. Efficient Sync Protocol

### 3.1 State Vector Diffing (Already Implemented)

Only transfer operations the client doesn't have:

```typescript
// Client sends their state vector
const localVector = Y.encodeStateVector(ydoc);

// Server computes diff
const diff = Y.encodeStateAsUpdate(serverDoc, localVector);

// Client applies only missing ops
Y.applyUpdate(ydoc, diff);
```

### 3.2 Memory-Efficient Server Sync

Process without loading full Y.Doc into memory:

```typescript
// Compute diff directly from stored updates
const storedState = await getStoredUpdate(document);
const clientVector = new Uint8Array(request.vector);

// These work on Uint8Array, no Y.Doc needed
const serverVector = Y.encodeStateVectorFromUpdate(storedState);
const diff = Y.diffUpdate(storedState, clientVector);

// Merge incoming update without Y.Doc
const newState = Y.mergeUpdates([storedState, incomingUpdate]);
await storeUpdate(document, newState);
```

### 3.3 Update Merging Strategy

Periodically merge deltas to reduce count while preserving history:

```typescript
// Merge updates for a document (preserves all CRDT operations)
export const mergeDocumentDeltas = internalMutation({
  args: { document: v.string() },
  handler: async (ctx, { document }) => {
    const deltas = await ctx.db.query("deltas")
      .withIndex("by_document", q => q.eq("document", document))
      .collect();

    if (deltas.length < 50) return; // Not worth merging yet

    // Merge all deltas (preserves full history)
    const merged = Y.mergeUpdates(deltas.map(d => new Uint8Array(d.bytes)));

    // Replace with single merged delta
    await ctx.db.insert("deltas", {
      document,
      bytes: merged,
      seq: deltas[deltas.length - 1].seq,
    });

    // Delete old deltas
    for (const delta of deltas) {
      await ctx.db.delete(delta._id);
    }
  },
});
```

---

## 4. Partial/Scoped Sync

### 4.1 Scope-Based Subscriptions

Only sync documents the user needs:

```typescript
// Schema: Documents belong to scopes
defineSchema({
  documents: defineTable({
    id: v.string(),
    scopes: v.array(v.string()),
    // ...
  }).index("by_scope", ["scopes"]),
});

// Query: Filter by user's scopes
export const stream = query({
  args: { scopes: v.array(v.string()), seq: v.number() },
  handler: async (ctx, { scopes, seq }) => {
    return ctx.db.query("deltas")
      .withIndex("by_scope_seq", q =>
        q.eq("scope", scopes[0]).gt("seq", seq))
      .take(1000);
  },
});
```

### 4.2 Lazy Document Loading

Load full CRDT content on-demand:

```typescript
// Initial sync: Metadata only (fast)
const material = await api.intervals.listMetadata();
// Returns: [{ id, title, updatedAt }, ...]

// On document open: Full CRDT state
const { bytes } = await api.intervals.getDocumentState({ id });
subdocManager.applyUpdate(id, new Uint8Array(bytes));
```

### 4.3 Priority-Based Sync

Sync visible/active documents first:

```typescript
class PrioritySyncQueue {
  private visible = new Set<string>();
  private queue: Array<{ doc: string; priority: number; bytes: Uint8Array }> = [];

  setVisible(docs: string[]) {
    this.visible = new Set(docs);
    this.queue.sort((a, b) => this.getPriority(a.doc) - this.getPriority(b.doc));
  }

  private getPriority(doc: string): number {
    return this.visible.has(doc) ? 0 : 1;
  }

  enqueue(doc: string, bytes: Uint8Array) {
    this.queue.push({ doc, priority: this.getPriority(doc), bytes });
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  async processNext(): Promise<boolean> {
    const item = this.queue.shift();
    if (!item) return false;

    await this.applyUpdate(item.doc, item.bytes);
    return true;
  }
}
```

---

## 5. Pagination & Streaming

### 5.1 Cursor-Based Pagination

Never use `.collect()` on large tables:

```typescript
// ❌ Bad: Loads all documents, causes OCC conflicts
const all = await ctx.db.query("documents").collect();

// ✅ Good: Paginated, indexed
const page = await ctx.db.query("documents")
  .withIndex("by_updated")
  .paginate(opts.paginationOpts);
```

### 5.2 Progressive Initial Load

Stream documents for faster time-to-interactive:

```typescript
// Server: Chunked response
export const streamMaterial = query({
  args: { cursor: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, { cursor, limit }) => {
    let query = ctx.db.query("documents").withIndex("by_id");

    if (cursor) {
      query = query.filter(q => q.gt(q.field("id"), cursor));
    }

    const docs = await query.take(limit);
    const nextCursor = docs.length === limit ? docs[docs.length - 1].id : null;

    return { docs, nextCursor, hasMore: !!nextCursor };
  },
});

// Client: Progressive loading with early render
async function loadCollection() {
  let cursor = null;
  let totalLoaded = 0;

  do {
    const { docs, nextCursor, hasMore } = await api.streamMaterial({
      cursor,
      limit: 100
    });

    // Apply batch and update UI immediately
    await applyBatchUpdates(docs);
    totalLoaded += docs.length;
    onProgress?.(totalLoaded);

    cursor = nextCursor;
  } while (cursor);
}
```

---

## 6. Scheduled Maintenance

### 6.1 Periodic Delta Merging

```typescript
import { cronJobs } from "convex/server";

const crons = cronJobs();

// Merge deltas for documents with many updates
crons.daily(
  "merge-deltas",
  { hour: 3, minute: 0 },
  internal.maintenance.mergeHighDeltaDocs,
  {}
);

export const mergeHighDeltaDocs = internalMutation({
  handler: async (ctx) => {
    // Find documents with >100 deltas
    const candidates = await ctx.db.query("documentStats")
      .withIndex("by_delta_count")
      .filter(q => q.gt(q.field("deltaCount"), 100))
      .take(50);

    for (const doc of candidates) {
      await ctx.scheduler.runAfter(0, internal.sync.mergeDocumentDeltas, {
        document: doc.id,
      });
    }
  },
});
```

---

## 7. Architecture Evolution

### Current Architecture

```
Client                          Server
──────                          ──────
┌──────────────┐               ┌──────────────┐
│  Y.Doc       │◄─────────────►│  Stream      │
│  (all docs)  │  Sequential   │  Query       │
└──────────────┘               └──────────────┘
```

**Limitations:**

- Single stream subscription
- Sequential delta application (mutex)
- All documents loaded upfront
- **Blocking server sync in mutation handlers**
- **UI rollback on server errors**
- Sequential for-loops instead of Promise.all

### Proposed Architecture

```
Client                                    Server
──────                                    ──────
┌─────────┐ ┌─────────┐ ┌─────────┐      ┌──────────────────┐
│ Doc A   │ │ Doc B   │ │ Doc C   │      │  Partitioned     │
│ Y.Doc   │ │ Y.Doc   │ │ Y.Doc   │      │  Stream Query    │
└────┬────┘ └────┬────┘ └────┬────┘      │  (by document)   │
     │           │           │            └────────┬─────────┘
     └───────────┼───────────┘                     │
                 │                                 │
         ┌───────┴───────┐                ┌────────┴────────┐
         │ Batch Manager │◄──────────────►│   Workpool      │
         │ - Debounce    │   Parallel     │   (parallel     │
         │ - Priority    │   by doc       │    mutations)   │
         │ - Merge       │                │                 │
         └───────────────┘                └─────────────────┘
```

**Benefits:**

- **Fire-and-forget mutations (no UI rollback)**
- **Retry queue with exponential backoff**
- Document-level parallelism (no OCC conflicts between docs)
- Promise.all everywhere (no sequential for-loops)
- Priority-based loading (visible first)
- Batched network calls
- Progressive rendering

---

## 8. Implementation Roadmap

### Phase 0: Fire-and-Forget Mutations (CRITICAL)

**Priority: Immediate - Fixes UI rollback bug**

- [ ] Convert onInsert to fire-and-forget with parallel mutations
- [ ] Convert onUpdate to fire-and-forget with parallel mutations
- [ ] Convert onDelete to fire-and-forget with parallel mutations
- [ ] Implement RetryQueue with exponential backoff
- [ ] Add sync status indicator for pending mutations
- [ ] Persist retry queue to localStorage (survive refresh)

### Phase 1: OCC Reduction (High Impact)

**Priority: Immediate - Reduces server errors**

- [ ] Write coalescing with debounce (50ms)
- [ ] Predicate-based index locking (narrow read sets)
- [ ] Replace for-loops with Promise.all everywhere
- [ ] Background compaction via scheduler

### Phase 2: Batch Operations (Low Risk)

- [ ] Client-side update batching with `Y.mergeUpdates()`
- [ ] Server-side batch mutations
- [ ] Batch SSR prefetching

### Phase 3: Parallel Processing (Medium Risk)

- [ ] Document-level parallel CRDT application
- [ ] Workpool integration for high-throughput sync
- [ ] Parallel stream subscription handling
- [ ] Sharded counters for delta counts

### Phase 4: Partial Sync (Higher Complexity)

- [ ] Scope/filter-based subscriptions
- [ ] Lazy document loading
- [ ] Priority-based sync queue

### Phase 5: Advanced Optimizations

- [ ] Aggregate component for collection stats
- [ ] HTTP Actions + CDN caching for SSR
- [ ] Periodic delta merging cron
- [ ] Hot/cold table separation

---

## Benchmarks (Target)

| Metric                  | Current          | Target              |
| ----------------------- | ---------------- | ------------------- |
| Initial load (1K docs)  | ~3s              | <500ms              |
| Initial load (10K docs) | N/A              | <2s                 |
| Delta apply (batch 100) | ~500ms           | <100ms              |
| Memory (10K docs)       | TBD              | <100MB              |
| Time to first render    | ~2s              | <200ms              |
| Rapid clicks (20x)      | ~10 succeed      | 20/20 persist       |
| Mutation UI response    | Blocks on server | Instant             |
| Server error handling   | Rollback UI      | Retry in background |

---

## 9. Advanced Convex Optimizations

### 9.1 Sharded Counter for High-Frequency Metrics

Track delta counts without OCC conflicts:

```typescript
import { ShardedCounter } from "@convex-dev/sharded-counter";

const deltaCounter = new ShardedCounter(components.deltaCounter, {
  shards: 16,  // Distribute writes across 16 shards
});

// In insert mutation - O(1) increment, no conflicts
export const insertDocument = mutation({
  handler: async (ctx, args) => {
    await ctx.db.insert("documents", { ... });
    await deltaCounter.increment(ctx, `${args.collection}:${args.document}`, 1);
  }
});

// In stream query - O(shards) count lookup
export const stream = query({
  handler: async (ctx, args) => {
    const count = await deltaCounter.count(ctx, `${args.collection}:${args.document}`);
    const shouldCompact = count >= 500;
    // ...
  }
});
```

### 9.2 Aggregate Component for Collection Stats

O(1) collection statistics without table scans:

```typescript
import { Aggregate } from "@convex-dev/aggregate";

const collectionStats = new Aggregate(components.collectionStats);

// Track on insert
await collectionStats.insert(ctx, `${collection}:documents`, {
  key: document,
  sumValue: bytes.byteLength,
});

// Get stats without scanning - O(1)
const stats = await collectionStats.sum(ctx, `${collection}:documents`);
// Returns { count: 1234, sum: 5678901 }
```

### 9.3 HTTP Actions with CDN Caching for SSR

Cache material queries at the edge:

```typescript
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/api/material/:collection",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const collection = url.pathname.split("/").pop();

    const data = await ctx.runQuery(api.tasks.material, { collection });

    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  }),
});

export default http;
```

### 9.4 Write Coalescing

Merge rapid writes on the same document:

```typescript
class WriteCoalescer {
  private pending = new Map<string, {
    delta: Uint8Array;
    material: unknown;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private debounceMs = 50;

  write(document: string, delta: Uint8Array, material: unknown) {
    const existing = this.pending.get(document);

    if (existing) {
      clearTimeout(existing.timer);
      // Merge deltas
      existing.delta = Y.mergeUpdates([existing.delta, delta]);
      existing.material = material;
      existing.timer = setTimeout(() => this.flush(document), this.debounceMs);
    } else {
      this.pending.set(document, {
        delta,
        material,
        timer: setTimeout(() => this.flush(document), this.debounceMs),
      });
    }
  }

  private async flush(document: string) {
    const item = this.pending.get(document);
    if (!item) return;

    this.pending.delete(document);
    await syncWithRetry("update", document, item.delta, item.material);
  }
}
```

### 9.5 Predicate-Based Index Locking

Reduce OCC conflicts by querying only what's needed:

```typescript
// ❌ Bad: Reads all sessions, conflicts with any session update
export const compact = mutation({
  handler: async (ctx, { document }) => {
    const sessions = await ctx.db.query("sessions").collect();
    const activeSessions = sessions.filter(s => s.document === document);
    // ...
  }
});

// ✅ Good: Only reads sessions for this document
export const compact = mutation({
  handler: async (ctx, { document }) => {
    const activeSessions = await ctx.db.query("sessions")
      .withIndex("by_document", q => q.eq("document", document))
      .collect();
    // Only conflicts with sessions for THIS document
  }
});
```

### 9.6 Background Compaction via Scheduler

Avoid blocking mutations with scheduled work:

```typescript
export const insertDocument = mutation({
  handler: async (ctx, args) => {
    await ctx.db.insert("deltas", { ... });

    // Check if compaction needed
    const deltaCount = await deltaCounter.count(ctx, args.document);
    if (deltaCount >= 500) {
      // Schedule background compaction - don't block
      await ctx.scheduler.runAfter(0, internal.sync.compactDocument, {
        document: args.document,
      });
    }
  }
});
```

### 9.7 Offline Queue Persistence

Persist retry queue to survive page refresh:

```typescript
class PersistentRetryQueue extends RetryQueue {
  private storageKey = "replicate:retryQueue";

  constructor() {
    super();
    this.loadFromStorage();
    window.addEventListener("beforeunload", () => this.saveToStorage());
  }

  private loadFromStorage() {
    const stored = localStorage.getItem(this.storageKey);
    if (stored) {
      const items = JSON.parse(stored);
      this.queue = items.map((item: any) => ({
        ...item,
        delta: new Uint8Array(item.delta),
      }));
      this.process();
    }
  }

  private saveToStorage() {
    const serializable = this.queue.map(item => ({
      ...item,
      delta: Array.from(item.delta),
    }));
    localStorage.setItem(this.storageKey, JSON.stringify(serializable));
  }
}
```

---

## 10. Priority Matrix

| Improvement                   | Effort | Impact   | OCC Reduction | Priority                  |
| ----------------------------- | ------ | -------- | ------------- | ------------------------- |
| **Fire-and-Forget Mutations** | Short  | Critical | ✅            | 🔴 Immediate              |
| **Write Coalescing**          | Quick  | High     | ✅ Direct     | 🔴 Do First               |
| **Predicate Index Locking**   | Short  | High     | ✅ Direct     | 🔴 Do First               |
| **Parallel Promise.all**      | Quick  | High     | ✅            | 🔴 Do First               |
| **RetryQueue**                | Short  | High     |               | 🟡 Important              |
| **Offline Queue Persistence** | Short  | High     |               | 🟡 Important              |
| **Sharded Counter**           | Short  | High     | ✅ Direct     | 🟡 If counting bottleneck |
| **Background Compaction**     | Short  | Medium   | ✅ Indirect   | 🟡 Nice to Have           |
| **Aggregate Component**       | Short  | Medium   |               | 🟢 Later                  |
| **HTTP + CDN for SSR**        | Quick  | Medium   |               | 🟢 If SSR load high       |
| **Subscription Chunking**     | Short  | Medium   |               | 🟢 Later                  |

---

## Key Insight: OCC is the Primary Bottleneck

The Convex architecture uses Optimistic Concurrency Control. Current OCC-prone patterns:

1. **`mark` mutations** - Update same session doc from all clients every 10s
2. **`compact` mutations** - Read all sessions to check safety
3. **`stream` queries** - Count all deltas per document

**Top fixes:**

1. Write Coalescing (reduce mutation frequency)
2. Predicate Locking (narrow read sets)
3. Sharded Counters (distribute write load)
4. Workpool (serialize high-contention writes)

---

## References

- [Convex Best Practices](https://docs.convex.dev/understanding/best-practices)
- [Convex OCC Documentation](https://docs.convex.dev/database/advanced/occ)
- [Convex Workpool](https://github.com/get-convex/workpool)
- [Convex Sharded Counter](https://github.com/get-convex/sharded-counter)
- [Convex Aggregate](https://github.com/get-convex/aggregate)
- [Yjs Document Updates](https://docs.yjs.dev/api/document-updates)
- [Yjs Performance Discussion](https://discuss.yjs.dev/t/optimizing-initial-load-of-a-document-receiving-a-lot-of-updates/2206)
- [Linear Sync Engine](https://github.com/wzhudev/reverse-linear-sync-engine)
