# Signals: Pagination + Unified Actor Architecture

> **Status:** Proposal  
> **Author:** Replicate Team  
> **Date:** January 2026

## Executive Summary

This document outlines a comprehensive architectural enhancement to the Replicate library that introduces:

1. **Simplified Server API** - From 11 exports down to 4: `material`, `delta`, `replicate`, `session`
2. **Convex Pagination** - Cursor-based pagination for SSR and infinite scroll
3. **Unified Actor Model** - All document changes (not just prose) go through actors
4. **Actor-Based Recovery** - Replace bulk recovery with per-document actor reconciliation
5. **Priority Queue System** - Visible documents sync first, background the rest

These changes will dramatically improve:

- **DX** - Clean, semantic API with only 4 exports
- **Performance** - Large datasets (1000+ documents)
- **Reconnection** - Offline → online with priority ordering
- **SSR** - First paint with minimal data
- **UX** - Infinite scroll, load on demand

---

## Table of Contents

1. [Simplified API Design](#1-simplified-api-design)
2. [Current Architecture Analysis](#2-current-architecture-analysis)
3. [Pagination Design](#3-pagination-design)
4. [Unified Actor Model](#4-unified-actor-model)
5. [Actor-Based Recovery](#5-actor-based-recovery)
6. [Priority Queue System](#6-priority-queue-system)
7. [API Reference](#7-api-reference)
8. [Implementation Phases](#8-implementation-phases)
9. [Migration Guide](#9-migration-guide)

---

## 1. Simplified API Design

### 1.1 Before vs After

```
┌─────────────────────────────────────────────────────────────────┐
│                    BEFORE (11 exports)                          │
├─────────────────────────────────────────────────────────────────┤
│  stream, material, insert, update, remove, recovery,            │
│  mark, compact, sessions, presence, materialPaginated           │
└─────────────────────────────────────────────────────────────────┘

                              ↓

┌─────────────────────────────────────────────────────────────────┐
│                    AFTER (4 exports)                            │
├─────────────────────────────────────────────────────────────────┤
│  material    - Paginated SSR + infinite scroll                  │
│  delta       - Real-time delta log subscription                 │
│  replicate   - Single mutation for ALL CRDT changes             │
│  session     - Unified session management (presence + sync)     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 New Server API

```typescript
// Server-side: 4 clean exports
const {
  material,    // Paginated query for SSR/hydration
  delta,       // Subscribe to delta log changes
  replicate,   // Push CRDT updates (insert/update/delete)
  session,     // Unified session management (join/leave/mark/signal + query)
} = collection.create<Doc<"intervals">>(components.replicate, "intervals");
```

### 1.3 Export Consolidation

| Old Export          | New Export      | Reasoning                                                             |
| ------------------- | --------------- | --------------------------------------------------------------------- |
| `stream`            | `delta`         | Better name - it's the delta log                                      |
| `material`          | `material`      | Now paginated by default                                              |
| `materialPaginated` | `material`      | Merged - pagination is default                                        |
| `insert`            | `replicate`     | Merged with `type: "insert"`                                          |
| `update`            | `replicate`     | Merged with `type: "update"`                                          |
| `remove`            | `replicate`     | Merged with `type: "delete"`                                          |
| `recovery`          | Internal        | Handled by actor reconciliation                                       |
| `mark`              | `session`       | Merged - now `session({ action: "mark" })` or piggybacked on `signal` |
| `compact`           | Internal        | Auto-triggered on write when threshold exceeded                       |
| `sessions`          | `session.query` | Merged into unified session API                                       |
| `presence`          | `session`       | Merged - session manages presence + sync state                        |

### 1.4 Why These Names?

| Export      | Semantic Meaning                                            |
| ----------- | ----------------------------------------------------------- |
| `material`  | The **materialized view** of your data                      |
| `delta`     | The **delta log** of CRDT changes                           |
| `replicate` | The core **replication** action (matches library name!)     |
| `session`   | Client **session** state (presence, sync progress, cursors) |

---

## 2. Current Architecture Analysis

### 2.1 Current Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        CURRENT STATE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  OUTBOUND (Client → Server)                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Prose Fields:  fragment.observe → Actor → debounce → sync  │ │
│  │ Other Fields:  TanStack update() → direct mutation         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  INBOUND (Server → Client)                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Stream: subscription(seq) → ALL deltas → apply to Yjs     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  RECOVERY (Reconnection)                                         │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Bulk: query ALL deltas since last seq → apply ALL at once │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  SSR (Server-Side Rendering)                                     │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ material(): db.query(collection).collect() → ALL docs     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Problems with Current Approach

| Issue                | Impact                                             | Severity |
| -------------------- | -------------------------------------------------- | -------- |
| 11 server exports    | Confusing API, hard to learn                       | High     |
| Prose-only actors    | Inconsistent sync behavior, special cases          | High     |
| Bulk recovery        | Memory spikes, slow reconnection, blocks UI        | High     |
| No pagination        | SSR loads entire dataset, slow first paint         | High     |
| Direct mutations     | No batching for field changes, excessive API calls | Medium   |
| No priority ordering | Background docs compete with visible ones          | Medium   |

### 2.3 Current Actor Implementation

**Location:** `src/client/services/actor.ts`

```typescript
// Current message types
type DocumentMessage =
  | { readonly _tag: "LocalChange" }      // User edited prose
  | { readonly _tag: "ExternalUpdate" }   // Server pushed change
  | { readonly _tag: "Shutdown" };        // Cleanup

// Current flow (prose only)
fragment.observeDeep() → actorManager.onLocalChange(docId) → debounce → sync
```

**Limitation:** Only `prose.ts` triggers `LocalChange`. Regular field updates bypass actors entirely.

---

## 3. Pagination Design

### 3.1 Convex Pagination API

Convex uses **cursor-based pagination** with the following primitives:

```typescript
import { paginationOptsValidator } from "convex/server";

interface PaginationOptions {
  numItems: number;        // How many items to fetch
  cursor: string | null;   // Opaque cursor for continuation
}

interface PaginationResult<T> {
  page: T[];               // Array of documents
  isDone: boolean;         // No more pages available
  continueCursor: string;  // Cursor for next page
}

// Usage
const result = await ctx.db
  .query("intervals")
  .order("desc")
  .paginate(paginationOpts);
```

### 3.2 New `material` Query (Server)

The `material` query is now **paginated by default**:

```typescript
// src/server/replicate.ts

createMaterialQuery(opts?: {
  evalRead?: (ctx: QueryCtx, collection: string) => Promise<void>;
  transform?: (docs: T[]) => T[] | Promise<T[]>;
}) {
  const collection = this.collectionName;
  const component = this.component;

  return queryGeneric({
    args: {
      paginationOpts: paginationOptsValidator,
      includeCRDT: v.optional(v.boolean()),
    },
    returns: v.object({
      page: v.array(v.any()),
      isDone: v.boolean(),
      continueCursor: v.string(),
      seq: v.optional(v.number()),
      crdt: v.optional(v.record(v.string(), v.object({
        bytes: v.bytes(),
        seq: v.number(),
      }))),
    }),
    handler: async (ctx, args) => {
      if (opts?.evalRead) {
        await opts.evalRead(ctx, collection);
      }

      // Paginated fetch from main table
      const result = await ctx.db
        .query(collection)
        .withIndex("by_timestamp")
        .order("desc")
        .paginate(args.paginationOpts);

      let docs = result.page as T[];
      if (opts?.transform) {
        docs = await opts.transform(docs);
      }

      // Optionally include CRDT state for hydration
      let crdt: Record<string, { bytes: ArrayBuffer; seq: number }> | undefined;
      let maxSeq = 0;

      if (args.includeCRDT) {
        crdt = {};
        for (const doc of docs) {
          const state = await ctx.runQuery(component.mutations.getDocumentState, {
            collection,
            document: (doc as any).id,
          });
          if (state) {
            crdt[(doc as any).id] = { bytes: state.bytes, seq: state.seq };
            maxSeq = Math.max(maxSeq, state.seq);
          }
        }
      }

      return {
        page: docs,
        isDone: result.isDone,
        continueCursor: result.continueCursor,
        seq: maxSeq > 0 ? maxSeq : undefined,
        crdt,
      };
    },
  });
}
```

### 3.3 New `delta` Query (Server)

Renamed from `stream` for clarity:

```typescript
// src/server/replicate.ts

createDeltaQuery(opts?: {
  evalRead?: (ctx: QueryCtx, collection: string) => Promise<void>;
}) {
  return queryGeneric({
    args: {
      seq: v.number(),
      limit: v.optional(v.number()),
    },
    returns: v.object({
      changes: v.array(v.object({
        document: v.string(),
        bytes: v.bytes(),
        seq: v.number(),
        type: v.string(),
        exists: v.boolean(),
      })),
      seq: v.number(),
      more: v.boolean(),
    }),
    handler: async (ctx, args) => {
      if (opts?.evalRead) {
        await opts.evalRead(ctx, this.collectionName);
      }

      return await ctx.runQuery(this.component.mutations.stream, {
        collection: this.collectionName,
        seq: args.seq,
        limit: args.limit ?? 1000,
      });
    },
  });
}
```

### 3.4 New `replicate` Mutation (Server)

Single mutation for ALL CRDT operations:

```typescript
// src/server/replicate.ts

createReplicateMutation(opts?: {
  evalWrite?: (ctx: MutationCtx, doc: T) => Promise<void>;
  onInsert?: (ctx: MutationCtx, doc: T) => Promise<void>;
  onUpdate?: (ctx: MutationCtx, doc: T) => Promise<void>;
  onDelete?: (ctx: MutationCtx, docId: string) => Promise<void>;
}) {
  return mutationGeneric({
    args: {
      document: v.string(),
      bytes: v.bytes(),
      material: v.optional(v.any()),
      type: v.union(v.literal("insert"), v.literal("update"), v.literal("delete")),
    },
    returns: v.object({
      success: v.boolean(),
      seq: v.number(),
    }),
    handler: async (ctx, args) => {
      const { document, bytes, material, type } = args;

      // Evaluate write permissions
      if (opts?.evalWrite && material) {
        await opts.evalWrite(ctx, material as T);
      }

      // Dispatch to appropriate handler
      switch (type) {
        case "insert": {
          if (opts?.onInsert && material) {
            await opts.onInsert(ctx, material as T);
          }
          return await ctx.runMutation(this.component.mutations.insertDocument, {
            collection: this.collectionName,
            document,
            bytes,
          });
        }

        case "update": {
          if (opts?.onUpdate && material) {
            await opts.onUpdate(ctx, material as T);
          }
          return await ctx.runMutation(this.component.mutations.updateDocument, {
            collection: this.collectionName,
            document,
            bytes,
          });
        }

        case "delete": {
          if (opts?.onDelete) {
            await opts.onDelete(ctx, document);
          }
          return await ctx.runMutation(this.component.mutations.deleteDocument, {
            collection: this.collectionName,
            document,
            bytes,
          });
        }
      }
    },
  });
}
```

### 3.5 New `session` API (Server)

Unified session management combining presence, sync progress, and awareness:

```typescript
// src/server/replicate.ts

createSessionMutation(opts?: {
  evalWrite?: (ctx: MutationCtx, client: string) => Promise<void>;
}) {
  return mutationGeneric({
    args: {
      document: v.string(),
      client: v.string(),
      action: v.union(
        v.literal("join"),    // Connect to document
        v.literal("leave"),   // Disconnect from document
        v.literal("mark"),    // Mark replication progress (vector + seq)
        v.literal("signal"),  // Keep-alive + update all state
      ),
      // For join/signal - user identity
      user: v.optional(v.string()),
      profile: v.optional(v.object({
        name: v.optional(v.string()),
        color: v.optional(v.string()),
        avatar: v.optional(v.string()),
      })),
      // For join/signal - cursor position
      cursor: v.optional(v.object({
        anchor: v.any(),
        head: v.any(),
        field: v.optional(v.string()),
      })),
      // For mark/signal - replication progress
      vector: v.optional(v.bytes()),
      seq: v.optional(v.number()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      if (opts?.evalWrite) {
        await opts.evalWrite(ctx, args.client);
      }

      await ctx.runMutation(this.component.mutations.session, {
        collection: this.collectionName,
        ...args,
      });

      return null;
    },
  });
}

// Query for active sessions
createSessionQuery(opts?: {
  evalRead?: (ctx: QueryCtx, collection: string) => Promise<void>;
}) {
  return queryGeneric({
    args: {
      document: v.string(),
      connected: v.optional(v.boolean()),
      exclude: v.optional(v.string()),
    },
    returns: v.array(sessionValidator),
    handler: async (ctx, args) => {
      if (opts?.evalRead) {
        await opts.evalRead(ctx, this.collectionName);
      }

      return await ctx.runQuery(this.component.mutations.sessions, {
        collection: this.collectionName,
        document: args.document,
        connected: args.connected ?? true,
        exclude: args.exclude,
      });
    },
  });
}
```

### 3.6 Internal Compaction (Auto-Triggered)

Compaction runs automatically when delta count exceeds threshold:

```typescript
// src/component/mutations.ts (internal)

// Called automatically by insertDocument/updateDocument/deleteDocument
const _triggerCompactionIfNeeded = async (
  ctx: MutationCtx,
  collection: string,
  document: string,
  threshold: number = 500,
) => {
  const count = await ctx.db
    .query("deltas")
    .withIndex("by_document", (q) =>
      q.eq("collection", collection).eq("document", document),
    )
    .collect()
    .then((d) => d.length);

  if (count >= threshold) {
    // Schedule internal compaction action
    await ctx.scheduler.runAfter(0, internal._compact, {
      collection,
      document,
    });
  }
};

// Internal action - not exposed to clients
export const _compact = internalAction({
  args: {
    collection: v.string(),
    document: v.string(),
  },
  handler: async (ctx, args) => {
    // 1. Load all deltas + existing snapshot
    // 2. Merge into new snapshot
    // 3. Check all sessions with vectors (connected + recent disconnected)
    // 4. Find minimum seq where all peers have synced
    // 5. Delete only deltas where seq <= minSafeSeq
    // 6. Always retain snapshot for recovery fallback
  },
});
```

**Key behaviors:**

- **Auto-triggered**: On every write, checks if delta count >= threshold
- **Peer-aware**: Only deletes deltas that ALL tracked peers have synced
- **Multi-week offline safe**: Sessions with vectors are retained, their needed deltas preserved
- **Fallback**: If deltas were compacted before a peer synced, peer uses `recovery` (state vector sync)

**Compaction configuration** (via `collection.create()` options):

```typescript
const { material, delta, replicate, session } = collection.create<T>(
  components.replicate,
  "intervals",
  {
    compaction: {
      sizeThreshold: "5mb",   // Trigger when document exceeds size (default: "5mb")
      peerTimeout: "24h",     // Consider peer stale after duration (default: "24h")
    },
  },
);
```

| Option          | Type       | Default | Description                                                          |
| --------------- | ---------- | ------- | -------------------------------------------------------------------- |
| `sizeThreshold` | `Size`     | `"5mb"` | Trigger compaction when document delta size exceeds this             |
| `peerTimeout`   | `Duration` | `"24h"` | Consider peer stale (safe to compact their data) after this duration |

### 3.7 Server Hooks

Hooks provide authorization and lifecycle callbacks for all operations:

```typescript
const { material, delta, replicate, session } = collection.create<T>(
  components.replicate,
  "intervals",
  {
    hooks: {
      // Permission checks (throw to reject)
      evalRead: async (ctx, collection) => { /* before material/delta queries */ },
      evalWrite: async (ctx, doc) => { /* before replicate mutations */ },
      evalSession: async (ctx, client) => { /* before session mutations (replaces evalMark) */ },

      // Lifecycle callbacks (run after operation)
      onDelta: async (ctx, result) => { /* after delta query (replaces onStream) */ },
      onReplicate: async (ctx, doc, type) => { /* after replicate mutation */ },
    },
  },
);
```

**Hook mapping from old API:**

| Old Hook      | New Hook      | Trigger                                              |
| ------------- | ------------- | ---------------------------------------------------- |
| `evalRead`    | `evalRead`    | Before `material`, `delta`, `session.query`          |
| `evalWrite`   | `evalWrite`   | Before `replicate` (insert/update/delete)            |
| `evalMark`    | `evalSession` | Before `session` mutations (join/leave/mark/signal)  |
| `evalCompact` | _(internal)_  | Compaction is now internal, no user hook needed      |
| `onStream`    | `onDelta`     | After `delta` query returns                          |
| `onInsert`    | `onReplicate` | After `replicate` with `type: "insert"`              |
| `onUpdate`    | `onReplicate` | After `replicate` with `type: "update"`              |
| `onRemove`    | `onReplicate` | After `replicate` with `type: "delete"`              |
| `transform`   | `transform`   | Transform documents before returning from `material` |

### 3.8 Client Configuration API

```typescript
// src/client/collection.ts

export interface PaginationConfig {
  /** Number of items per page (default: 25) */
  pageSize?: number;

  /** Initial pages to load on SSR (default: 1) */
  ssrPages?: number;

  /** Whether to include CRDT state in SSR (default: true) */
  ssrIncludeCRDT?: boolean;

  /** Enable infinite scroll behavior (default: true) */
  infiniteScroll?: boolean;

  /** Preload next page when within threshold (default: 5 items) */
  preloadThreshold?: number;
}

export interface CollectionOptions<T extends object> {
  persistence: () => Promise<Persistence>;
  config: () => {
    convexClient: ConvexClient;
    api: {
      material: FunctionReference<"query">;
      delta: FunctionReference<"query">;
      replicate: FunctionReference<"mutation">;
      session: FunctionReference<"mutation">;  // Unified session API
    };
    getKey: (doc: T) => string;
  };
  pagination?: PaginationConfig;
}

// Usage
export const intervals = collection.create(schema, "intervals", {
  persistence: sqlite,
  config: () => ({
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.intervals,  // { material, delta, replicate, session }
    getKey: (interval) => interval.id,
  }),
  pagination: {
    pageSize: 25,
    ssrPages: 2,
    ssrIncludeCRDT: true,
    infiniteScroll: true,
    preloadThreshold: 5,
  },
});
```

### 3.9 SSR Hydration Flow

**Server (TanStack Start / SvelteKit / Next.js):**

```typescript
// routes/index.tsx

export const Route = createFileRoute("/")({
  loader: async () => {
    const convex = createConvexHttpClient(CONVEX_URL);

    // Fetch first 2 pages with CRDT state
    const page1 = await convex.query(api.intervals.material, {
      paginationOpts: { numItems: 25, cursor: null },
      includeCRDT: true,
    });

    const page2 = !page1.isDone
      ? await convex.query(api.intervals.material, {
          paginationOpts: { numItems: 25, cursor: page1.continueCursor },
          includeCRDT: true,
        })
      : null;

    return {
      initialData: {
        pages: [page1, page2].filter(Boolean),
        cursor: page2?.continueCursor ?? page1.continueCursor,
        isDone: page2?.isDone ?? page1.isDone,
        crdt: { ...page1.crdt, ...page2?.crdt },
        seq: Math.max(page1.seq ?? 0, page2?.seq ?? 0),
      },
    };
  },
});
```

**Client Hydration:**

```typescript
// src/client/collection.ts

async initWithMaterial(material: PaginatedMaterial<T>): Promise<void> {
  const persistence = await this.options.persistence();

  // 1. Apply CRDT state for all SSR documents
  for (const [docId, state] of Object.entries(material.crdt)) {
    const update = new Uint8Array(state.bytes);
    this.docManager.applyUpdate(docId, update, YjsOrigin.Server);
    this.registry.load([docId]);
  }

  // 2. Insert documents into TanStack DB
  for (const page of material.pages) {
    this.ops.insert(page.page);
  }

  // 3. Store pagination state
  this.paginationState = {
    cursor: material.cursor,
    isDone: material.isDone,
    loadedPages: material.pages.length,
  };

  // 4. Start delta subscription from SSR seq (skip already-loaded deltas)
  this.startDeltaSubscription(material.seq);

  // 5. Ready immediately - no loading state for SSR docs!
  this.markReady();
}
```

### 3.10 Infinite Scroll Integration

```typescript
// React example with TanStack Virtual

function IntervalList() {
  const collection = useIntervals();
  const { status, load, canLoadMore } = collection.pagination;

  const parentRef = useRef<HTMLDivElement>(null);
  const documents = collection.get().query().toArray();

  const virtualizer = useVirtualizer({
    count: documents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  // Preload when near bottom
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];

    if (
      lastItem &&
      lastItem.index >= documents.length - 5 &&
      canLoadMore &&
      status === "idle"
    ) {
      load();
    }
  }, [virtualizer.getVirtualItems(), canLoadMore, status]);

  return (
    <div ref={parentRef} style={{ height: "100vh", overflow: "auto" }}>
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <IntervalRow key={item.key} interval={documents[item.index]} />
        ))}
      </div>
      {status === "busy" && <LoadingSpinner />}
    </div>
  );
}
```

---

## 4. Unified Actor Model

### 4.1 Design Goals

1. **All changes through actors** - Prose fields, regular fields, deletes
2. **Single sync path** - No special cases
3. **Consistent batching** - All changes debounced
4. **Unified pending state** - One source of truth per document

### 4.2 New Message Types

```typescript
// src/client/services/actor.ts

export type DocumentMessage =
  // Existing
  | { readonly _tag: "LocalChange" }
  | { readonly _tag: "ExternalUpdate" }
  | { readonly _tag: "Shutdown"; readonly done: Deferred.Deferred<void, never> }

  // New
  | { readonly _tag: "Reconcile"; readonly done: Deferred.Deferred<ReconcileResult, SyncError> }
  | { readonly _tag: "SetPriority"; readonly priority: ActorPriority };

interface ReconcileResult {
  localChanges: number;   // Changes pushed to server
  remoteChanges: number;  // Changes received from server
  conflicts: number;      // Merge conflicts (CRDT resolves automatically)
}
```

### 4.3 Actor State

```typescript
// src/client/services/actor.ts

interface ActorState {
  // Existing
  readonly vector: Uint8Array;
  readonly lastError: SyncError | null;
  readonly retryCount: number;

  // New
  readonly status: ActorStatus;
  readonly priority: ActorPriority;
  readonly lastSyncAt: number | null;
  readonly pendingFields: Set<string>;
}

type ActorStatus =
  | "idle"           // No pending changes
  | "pending"        // Changes waiting for debounce
  | "syncing"        // Currently syncing to server
  | "reconciling"    // Performing recovery reconciliation
  | "error";         // Failed, waiting for retry

type ActorPriority =
  | "critical"       // Visible document, sync immediately
  | "high"           // Recently edited
  | "normal"         // Background document
  | "low";           // Offscreen, defer sync
```

### 4.4 Unified Sync Function

```typescript
// src/client/services/actor.ts

const performSync = Effect.gen(function* () {
  const state = yield* Ref.get(stateRef);

  // Compute delta from last known vector
  const delta = Y.encodeStateAsUpdateV2(ydoc, state.vector);

  // Skip if no actual changes
  if (delta.length <= 2) {
    return;
  }

  // Serialize full document for material sync
  const material = serializeYMapValue(ymap);
  const bytes = delta.buffer as ArrayBuffer;

  // Determine operation type
  const type = state.isNew ? "insert" : state.isDeleted ? "delete" : "update";

  // Single mutation handles everything via `replicate`
  yield* Effect.tryPromise({
    try: () => replicateFn({ document: documentId, bytes, material, type }),
    catch: (e) => new SyncError({
      documentId,
      cause: e,
      retriable: isRetriable(e),
    }),
  });

  // Update vector after successful sync
  const newVector = Y.encodeStateVector(ydoc);
  yield* Ref.update(stateRef, (s) => ({
    ...s,
    vector: newVector,
    retryCount: 0,
    lastError: null,
    lastSyncAt: Date.now(),
    status: "idle",
    isNew: false,
  }));
});
```

### 4.5 Document-Level Observer

**Key Change:** Observe entire `ydoc`, not just prose fragments.

```typescript
// src/client/documents.ts

export function observeDocument(
  documentId: string,
  ydoc: Y.Doc,
  actorManager: ActorManager,
  runtime: ReplicateRuntime,
): () => void {
  const ymap = ydoc.getMap("content");

  // Observe ALL changes to the document
  const handler = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
    // Skip server-originated changes
    if (transaction.origin === YjsOrigin.Server) {
      return;
    }

    // Notify actor of local change
    runWithRuntime(runtime, actorManager.onLocalChange(documentId));
  };

  ymap.observeDeep(handler);

  return () => {
    ymap.unobserveDeep(handler);
  };
}
```

### 4.6 Integration with TanStack DB

```typescript
// src/client/collection.ts

const createMutationHandlers = <T extends object>(
  actorManager: ActorManager,
  runtime: ReplicateRuntime,
  docManager: DocumentManager,
) => ({
  onInsert: async (mutation: CollectionMutation<T>) => {
    const docId = mutation.key as string;
    const ydoc = docManager.getOrCreate(docId);
    const ymap = ydoc.getMap("content");

    // Apply insert to Yjs doc
    ydoc.transact(() => {
      for (const [key, value] of Object.entries(mutation.modified)) {
        ymap.set(key, value);
      }
    }, YjsOrigin.Local);

    // Register actor for this document (marks as new)
    const replicateFn = createReplicateFn(docId, ydoc, ymap, collection);
    await runWithRuntime(runtime, actorManager.register(docId, ydoc, replicateFn, { isNew: true }));

    // Actor will handle sync via observer
  },

  onUpdate: async (mutation: CollectionMutation<T>) => {
    const docId = mutation.key as string;
    const ydoc = docManager.get(docId);
    if (!ydoc) return;

    const ymap = ydoc.getMap("content");

    // Apply changes to Yjs doc
    ydoc.transact(() => {
      for (const [key, value] of Object.entries(mutation.changes ?? {})) {
        ymap.set(key, value);
      }
    }, YjsOrigin.Local);

    // Actor observer will trigger sync automatically
  },

  onDelete: async (mutation: CollectionMutation<T>) => {
    const docId = mutation.key as string;

    // Mark document as deleted in actor state
    await runWithRuntime(runtime, actorManager.markDeleted(docId));

    // Actor will sync the delete
  },
});
```

---

## 5. Actor-Based Recovery

### 5.1 Current Recovery (Problems)

```typescript
// Current: Bulk recovery on reconnect
const recoverFromServer = async () => {
  // 1. Fetch ALL deltas since last cursor
  const result = await convexClient.query(api.delta, {
    seq: lastCursor,
    limit: 10000,  // Potentially huge!
  });

  // 2. Apply ALL at once
  for (const change of result.changes) {
    docManager.applyUpdate(change.document, change.bytes);
  }

  // Problems:
  // - Memory spike for large delta sets
  // - Blocks UI during application
  // - No prioritization (invisible docs same as visible)
  // - All-or-nothing (fails entirely on any error)
};
```

### 5.2 Actor-Based Recovery (Solution)

```typescript
// New: Per-document reconciliation via actors

// src/client/services/actor.ts

const handleReconcile = Effect.gen(function* () {
  yield* Ref.update(stateRef, (s) => ({ ...s, status: "reconciling" }));

  const state = yield* Ref.get(stateRef);
  const localVector = Y.encodeStateVector(ydoc);

  // 1. Query server for our specific document's state
  const response = yield* Effect.tryPromise({
    try: () => recoveryFn({
      document: documentId,
      vector: localVector.buffer,
    }),
    catch: (e) => new SyncError({ documentId, cause: e, retriable: true }),
  });

  let remoteChanges = 0;
  let localChanges = 0;

  // 2. Apply server diff if we're behind
  if (response.diff && response.diff.byteLength > 0) {
    Y.applyUpdateV2(ydoc, new Uint8Array(response.diff), YjsOrigin.Server);
    remoteChanges = 1;
  }

  // 3. Push local changes if server is behind
  const serverVector = new Uint8Array(response.vector);
  const localDelta = Y.encodeStateAsUpdateV2(ydoc, serverVector);

  if (localDelta.length > 2) {
    yield* performSync;  // Reuse existing sync logic
    localChanges = 1;
  }

  // 4. Update state
  yield* Ref.update(stateRef, (s) => ({
    ...s,
    vector: Y.encodeStateVector(ydoc),
    status: "idle",
    lastSyncAt: Date.now(),
  }));

  return { localChanges, remoteChanges, conflicts: 0 };
});
```

### 5.3 Reconnection Flow

```typescript
// src/client/collection.ts

const handleReconnection = async () => {
  const ctx = getContext(collectionName);
  const { actorManager, runtime, registry } = ctx;

  // 1. Get list of all loaded documents
  const loadedDocs = Array.from(registry.loaded);

  // 2. Partition by visibility/priority
  const visibleDocs = loadedDocs.filter(isDocumentVisible);
  const backgroundDocs = loadedDocs.filter((d) => !isDocumentVisible(d));

  // 3. Reconcile visible documents first (in parallel, limited concurrency)
  const visibleResults = await runWithRuntime(
    runtime,
    Effect.all(
      visibleDocs.map((docId) => actorManager.reconcile(docId)),
      { concurrency: 5 },
    ),
  );

  // 4. Mark UI as ready after visible docs synced
  markReady();

  // 5. Reconcile background documents with lower priority
  for (const batch of chunk(backgroundDocs, 10)) {
    await runWithRuntime(
      runtime,
      Effect.all(
        batch.map((docId) => actorManager.reconcile(docId)),
        { concurrency: 3 },
      ),
    );

    // Yield to main thread between batches
    await new Promise((r) => setTimeout(r, 50));
  }
};
```

### 5.4 Benefits of Actor-Based Recovery

| Aspect      | Bulk Recovery               | Actor Recovery          |
| ----------- | --------------------------- | ----------------------- |
| Memory      | Spikes (all deltas at once) | Constant (per-doc)      |
| UI Blocking | Yes (entire recovery)       | No (incremental)        |
| Priority    | None                        | Visible first           |
| Failure     | All-or-nothing              | Per-document retry      |
| Resume      | Restart from beginning      | Continue where left off |
| Bandwidth   | Redundant (re-fetch known)  | Minimal (vector diff)   |

---

## 6. Priority Queue System

### 6.1 Queue Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Priority Queue System                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  CRITICAL   │  │    HIGH     │  │   NORMAL    │  ┌─────────┐ │
│  │  (visible)  │→ │  (recent)   │→ │ (background)│→ │   LOW   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  │(offscreen)│
│        ↓                ↓                ↓          └─────────┘ │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Queue Processor                        │   │
│  │  - Processes CRITICAL immediately (no debounce)          │   │
│  │  - HIGH: 100ms debounce, 3 concurrent                     │   │
│  │  - NORMAL: 200ms debounce, 2 concurrent                   │   │
│  │  - LOW: 500ms debounce, 1 concurrent                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Priority Assignment

```typescript
// src/client/services/priority.ts

export interface PriorityConfig {
  /** Callback to determine if document is visible */
  isVisible?: (documentId: string) => boolean;

  /** Time threshold for "recent" edit (ms) */
  recentThreshold?: number;  // default: 5000

  /** Custom priority override */
  getPriority?: (documentId: string) => ActorPriority;
}

export const determinePriority = (
  documentId: string,
  state: ActorState,
  config: PriorityConfig,
): ActorPriority => {
  // Custom override
  if (config.getPriority) {
    return config.getPriority(documentId);
  }

  // Visible documents are critical
  if (config.isVisible?.(documentId)) {
    return "critical";
  }

  // Recently edited documents are high priority
  const recentThreshold = config.recentThreshold ?? 5000;
  if (state.lastSyncAt && Date.now() - state.lastSyncAt < recentThreshold) {
    return "high";
  }

  // Default to normal
  return "normal";
};
```

### 6.3 Queue Processor

```typescript
// src/client/services/queue.ts

interface QueueConfig {
  critical: { debounceMs: 0; concurrency: 10 };
  high: { debounceMs: 100; concurrency: 3 };
  normal: { debounceMs: 200; concurrency: 2 };
  low: { debounceMs: 500; concurrency: 1 };
}

export const createPriorityQueue = (
  config: QueueConfig = defaultConfig,
): Effect.Effect<PriorityQueue, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Separate queues per priority
    const criticalQueue = yield* Queue.unbounded<QueuedSync>();
    const highQueue = yield* Queue.unbounded<QueuedSync>();
    const normalQueue = yield* Queue.unbounded<QueuedSync>();
    const lowQueue = yield* Queue.unbounded<QueuedSync>();

    // Processors with different concurrency
    yield* Effect.forkScoped(processQueue(criticalQueue, config.critical));
    yield* Effect.forkScoped(processQueue(highQueue, config.high));
    yield* Effect.forkScoped(processQueue(normalQueue, config.normal));
    yield* Effect.forkScoped(processQueue(lowQueue, config.low));

    return {
      enqueue: (sync: QueuedSync) => {
        switch (sync.priority) {
          case "critical": return Queue.offer(criticalQueue, sync);
          case "high": return Queue.offer(highQueue, sync);
          case "normal": return Queue.offer(normalQueue, sync);
          case "low": return Queue.offer(lowQueue, sync);
        }
      },

      promote: (documentId: string, priority: ActorPriority) =>
        Effect.gen(function* () {
          // Move from current queue to target queue
        }),
    };
  });
```

### 6.4 Visibility Detection

```typescript
// src/client/services/visibility.ts

export const createVisibilityTracker = (): VisibilityTracker => {
  const visibleDocs = new Set<string>();
  const observers = new Map<string, IntersectionObserver>();

  return {
    observe: (documentId: string, element: HTMLElement) => {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              visibleDocs.add(documentId);
            } else {
              visibleDocs.delete(documentId);
            }
          }
        },
        { threshold: 0.1 },
      );

      observer.observe(element);
      observers.set(documentId, observer);

      return () => {
        observer.disconnect();
        observers.delete(documentId);
        visibleDocs.delete(documentId);
      };
    },

    isVisible: (documentId: string) => visibleDocs.has(documentId),
    getVisible: () => Array.from(visibleDocs),
  };
};
```

---

## 7. API Reference

### 7.1 Server API (4 exports)

```typescript
// Server-side collection creation
const {
  material,    // Paginated SSR query
  delta,       // Real-time delta subscription
  replicate,   // Single mutation for all CRDT changes
  session,     // Unified session management
} = collection.create<Doc<"intervals">>(components.replicate, "intervals");
```

#### `material` - Paginated Query

```typescript
material(args: {
  paginationOpts: { numItems: number; cursor: string | null };
  includeCRDT?: boolean;
}): Promise<{
  page: T[];
  isDone: boolean;
  continueCursor: string;
  seq?: number;
  crdt?: Record<string, { bytes: ArrayBuffer; seq: number }>;
}>
```

#### `delta` - Real-time Subscription

```typescript
delta(args: {
  seq: number;
  limit?: number;
}): {
  changes: Array<{
    document: string;
    bytes: ArrayBuffer;
    seq: number;
    type: string;
    exists: boolean;
  }>;
  seq: number;
  more: boolean;
}
```

#### `replicate` - CRDT Mutation

```typescript
replicate(args: {
  document: string;
  bytes: ArrayBuffer;
  material?: T;
  type: "insert" | "update" | "delete";
}): Promise<{
  success: boolean;
  seq: number;
}>
```

#### `session` - Unified Session Management

```typescript
// Mutation - manage session state
session(args: {
  document: string;
  client: string;
  action: "join" | "leave" | "mark" | "signal";
  // For join/signal - user identity
  user?: string;
  profile?: { name?: string; color?: string; avatar?: string };
  // For join/signal - cursor position
  cursor?: { anchor: any; head: any; field?: string };
  // For mark/signal - replication progress
  vector?: ArrayBuffer;
  seq?: number;
}): Promise<null>

// Query - get active sessions
session.query(args: {
  document: string;
  connected?: boolean;
  exclude?: string;
}): Promise<Session[]>
```

**Action semantics:**

- `join` - Connect to document, set `connected=true`, optionally set user/profile/cursor
- `leave` - Disconnect from document, set `connected=false`, clear cursor
- `mark` - Mark replication progress (vector + seq) after applying deltas from server
- `signal` - Keep-alive combining all of the above (presence + replication progress)

### 7.2 Client API

```typescript
// Collection creation
const collection = collection.create(schema, "tableName", {
  persistence: () => sqlite(),
  config: () => ({
    convexClient,
    api: api.tableName,  // { material, delta, replicate, session }
    getKey: (doc) => doc.id,
  }),
  pagination: { pageSize: 25, ssrPages: 2 },
  actors: { debounceMs: 200, maxRetries: 3 },
});

// Type extraction
type Interval = collection.Doc<typeof intervals>;

// Instance methods
interface LazyCollection<T> {
  init(material?: PaginatedMaterial<T>): Promise<void>;
  get(): Collection<T>;

  pagination: {
    load(): Promise<PaginatedPage<T>>;
    status: PaginationStatus;  // "idle" | "busy" | "done" | "error"
    canLoadMore: boolean;
    count: number;
    subscribe(cb: (state: PaginationState) => void): () => void;
  };

  actors: {
    getPending(documentId: string): boolean;
    onPendingChange(documentId: string, cb: (pending: boolean) => void): () => void;
    reconcile(documentId: string): Promise<ReconcileResult>;
    reconcileAll(): Promise<ReconcileResult[]>;
    markVisible(documentId: string, element: HTMLElement): () => void;
  };

  session: {
    join(documentId: string, opts?: SessionJoinOptions): Promise<void>;
    leave(documentId: string): Promise<void>;
    updateCursor(documentId: string, cursor: Cursor): Promise<void>;
    getSessions(documentId: string): Promise<Session[]>;
    onSessionsChange(documentId: string, cb: (sessions: Session[]) => void): () => void;
  };
}
```

### 7.3 Actor Messages

```typescript
type DocumentMessage =
  | { _tag: "LocalChange" }
  | { _tag: "ExternalUpdate" }
  | { _tag: "Reconcile"; done: Deferred<ReconcileResult, SyncError> }
  | { _tag: "Shutdown"; done: Deferred<void, never> }
  | { _tag: "SetPriority"; priority: ActorPriority };

type ActorPriority = "critical" | "high" | "normal" | "low";
type ActorStatus = "idle" | "pending" | "syncing" | "reconciling" | "error";

interface ReconcileResult {
  localChanges: number;
  remoteChanges: number;
  conflicts: number;
}
```

---

## 8. Implementation Phases

Each phase is **contained and testable** - the system works after each phase completes.

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: New Server API (backward compatible)                  │
│  └── Add new exports, keep old ones working                     │
├─────────────────────────────────────────────────────────────────┤
│  Phase 2: Client Migration                                      │
│  └── Switch client to use new API, update examples              │
├─────────────────────────────────────────────────────────────────┤
│  Phase 3: Pagination                                            │
│  └── Add pagination to material query, SSR hydration            │
├─────────────────────────────────────────────────────────────────┤
│  Phase 4: Unified Actor Model                                   │
│  └── All changes through actors, priority queue, recovery       │
└─────────────────────────────────────────────────────────────────┘
```

---

### Phase 1: New Server API (Backward Compatible)

**Goal:** Add new consolidated exports while keeping old ones working for gradual migration.

**Commits:**

1. **Add `replicate` mutation**
   - Combines `insert`/`update`/`remove` with `type: "insert" | "update" | "delete"` field
   - File: `src/server/replicate.ts`

2. **Add `session` mutation**
   - Combines `mark`/`presence` with `action: "join" | "leave" | "mark" | "signal"` field
   - Rename `sessions` query to `session.query`
   - File: `src/server/replicate.ts`

3. **Rename `stream` → `delta`**
   - Keep `stream` as deprecated alias for backward compatibility
   - File: `src/server/replicate.ts`

4. **Internal compact auto-trigger**
   - Add `_compact` internal action triggered on write when threshold exceeded
   - Keep old `compact` export for manual/admin use
   - Files: `src/component/mutations.ts`, `src/server/replicate.ts`

**Files to modify:**

- `src/server/replicate.ts` - Add new methods, keep old as deprecated
- `src/server/collection.ts` - Update factory to export both old and new
- `src/component/mutations.ts` - Add internal compact trigger
- `src/shared/validators.ts` - Add new validators for `replicate` and `session`

**Test:** Old examples still work unchanged (backward compatible)

---

### Phase 2: Client Migration

**Goal:** Switch client to use new API, then remove deprecated server exports.

**Commits:**

1. **Update `ConvexCollectionApi` interface**
   - New shape: `{ material, delta, replicate, session }`
   - File: `src/client/collection.ts`

2. **Migrate mutations to `replicate`**
   - `onInsert` → `api.replicate({ type: "insert", ... })`
   - `onUpdate` → `api.replicate({ type: "update", ... })`
   - `onDelete` → `api.replicate({ type: "delete", ... })`
   - File: `src/client/collection.ts`

3. **Migrate subscription to `delta` + `session`**
   - Use `api.delta` instead of `api.stream`
   - Use `api.session({ action: "mark" })` instead of `api.mark`
   - Remove client-side compact calls (now internal)
   - File: `src/client/collection.ts`

4. **Migrate prose binding to `session`**
   - Use `api.session` instead of `api.presence`
   - Use `api.session.query` instead of `api.sessions`
   - File: `src/client/services/awareness.ts`

5. **Update examples**
   - Update TanStack Start example to use new 4-export API
   - Update SvelteKit example to use new 4-export API
   - Files: `examples/tanstack-start/convex/`, `examples/sveltekit/src/convex/`

6. **Remove deprecated exports**
   - Remove old method aliases from server
   - File: `src/server/replicate.ts`, `src/server/collection.ts`

**Test:** Examples work with new 4-export API

---

### Phase 3: Pagination

**Goal:** Add pagination support to material query and client.

**Commits:**

1. **Server: paginated `material` query**
   - Add `paginationOpts` argument support
   - Return `{ page, isDone, continueCursor, seq?, crdt? }`
   - File: `src/server/replicate.ts`

2. **Client: pagination state**
   - Add `PaginationConfig` interface
   - Track cursor and status (idle/busy/done/error)
   - Add `load()` method and `subscribe()` for reactivity
   - File: `src/client/collection.ts`

3. **Client: SSR hydration with pagination**
   - Handle paginated material in `init()`
   - Support multiple pages in initial load
   - File: `src/client/collection.ts`

4. **Examples: infinite scroll**
   - Add infinite scroll demo to TanStack Start
   - Add infinite scroll demo to SvelteKit
   - Files: `examples/tanstack-start/`, `examples/sveltekit/`

**Test:** SSR loads first page, infinite scroll loads more

---

### Phase 4: Unified Actor Model

**Goal:** All changes through actors, priority queue, actor-based recovery.

**Commits:**

1. **Document-level observer**
   - Observe entire Y.Doc changes, not just prose fragments
   - Trigger actor on any field change
   - File: `src/client/documents.ts`

2. **Route mutations through actors**
   - `onInsert`/`onUpdate`/`onDelete` queue through actor
   - Actor batches and syncs changes
   - Files: `src/client/collection.ts`, `src/client/services/actor.ts`

3. **Actor-based recovery**
   - Add `Reconcile` message type
   - Replace bulk `recover()` with per-document actor reconciliation
   - Files: `src/client/services/actor.ts`, `src/client/collection.ts`

4. **Priority queue**
   - Add priority levels: critical, high, normal, low
   - Visible documents sync first
   - Files: `src/client/services/queue.ts`, `src/client/services/priority.ts`

5. **Simplify prose.ts**
   - Remove actor registration (handled at document level)
   - Keep fragment observation for editor binding
   - File: `src/client/prose.ts`

**Test:** All field changes sync through actors, reconnection prioritizes visible docs

---

### Estimated Timeline

| Phase                        | Duration | Cumulative |
| ---------------------------- | -------- | ---------- |
| Phase 1: New Server API      | 2-3 days | 2-3 days   |
| Phase 2: Client Migration    | 2-3 days | 4-6 days   |
| Phase 3: Pagination          | 2-3 days | 6-9 days   |
| Phase 4: Unified Actor Model | 4-5 days | 10-14 days |

**Total: ~2 weeks**

---

## 9. Migration Guide

### 9.1 Server API Migration

```typescript
// BEFORE (11 exports)
const {
  stream, material, insert, update, remove,
  recovery, mark, compact, sessions, presence,
  materialPaginated,
} = collection.create<T>(component, "tableName");

// AFTER (4 exports)
const {
  material,    // Paginated by default
  delta,       // Renamed from stream
  replicate,   // Replaces insert/update/remove
  session,     // Unified: sessions + presence + mark (sync progress)
} = collection.create<T>(component, "tableName");
```

### 9.2 Client API Migration

```typescript
// BEFORE
api: {
  stream: api.intervals.stream,
  material: api.intervals.material,
  insert: api.intervals.insert,
  update: api.intervals.update,
  remove: api.intervals.remove,
  mark: api.intervals.mark,
  // ...
}

// AFTER
api: api.intervals,  // { material, delta, replicate, session }

// Note: mark is now under session API via action: "mark" or "signal"
```

### 9.3 SSR Migration

```typescript
// BEFORE
const material = await convex.query(api.intervals.material, {});

// AFTER
const page1 = await convex.query(api.intervals.material, {
  paginationOpts: { numItems: 50, cursor: null },
  includeCRDT: true,
});
```

### 9.4 Mutation Migration

```typescript
// BEFORE
await convex.mutation(api.intervals.insert, { document, bytes, material });
await convex.mutation(api.intervals.update, { document, bytes, material });
await convex.mutation(api.intervals.remove, { document, bytes });

// AFTER
await convex.mutation(api.intervals.replicate, { document, bytes, material, type: "insert" });
await convex.mutation(api.intervals.replicate, { document, bytes, material, type: "update" });
await convex.mutation(api.intervals.replicate, { document, bytes, type: "delete" });
```

### 9.5 Breaking Changes

| Change                                   | Migration                                           |
| ---------------------------------------- | --------------------------------------------------- |
| `stream` → `delta`                       | Rename import                                       |
| `insert`/`update`/`remove` → `replicate` | Add `type` field                                    |
| `sessions` → `session.query`             | Update to unified session API                       |
| `presence` → `session`                   | Rename + use `action` field                         |
| `mark` → `session`                       | Now via `action: "mark"` or `action: "signal"`      |
| `compact` → internal                     | No longer called by client; auto-triggered on write |
| `material` now paginated                 | Add `paginationOpts`                                |

---

## Appendix A: Convex Pagination Reference

### paginationOptsValidator

```typescript
import { paginationOptsValidator } from "convex/server";

// Validates:
{
  numItems: number;        // Required: items per page
  cursor: string | null;   // Required: null for first page
}
```

### PaginationResult

```typescript
interface PaginationResult<T> {
  page: T[];               // Documents in this page
  isDone: boolean;         // true if no more pages
  continueCursor: string;  // Pass to next query for more
}
```

### usePaginatedQuery (React)

```typescript
import { usePaginatedQuery } from "convex/react";

const { results, status, loadMore } = usePaginatedQuery(
  api.collection.list,
  { /* extra args */ },
  { initialNumItems: 25 },
);

// status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
```

---

## Appendix B: Effect.ts Queue Reference

### Queue Creation

```typescript
import { Queue, Effect } from "effect";

// Unbounded queue (no backpressure)
const queue = yield* Queue.unbounded<Message>();

// Bounded queue (blocks when full)
const bounded = yield* Queue.bounded<Message>(100);

// Dropping queue (drops oldest when full)
const dropping = yield* Queue.dropping<Message>(100);
```

### Queue Operations

```typescript
// Add item
yield* Queue.offer(queue, message);

// Take single item (blocks if empty)
const item = yield* Queue.take(queue);

// Take all available items
const items = yield* Queue.takeAll(queue);

// Check size
const size = yield* Queue.size(queue);
```

---

## Appendix C: File Structure After Implementation

```
src/client/
├── services/
│   ├── actor.ts         # Extended with Reconcile, priority
│   ├── manager.ts       # Extended with reconcile, visibility
│   ├── queue.ts         # NEW: Priority queue system
│   ├── priority.ts      # NEW: Priority determination
│   ├── visibility.ts    # NEW: Visibility tracking
│   ├── runtime.ts       # Unchanged
│   ├── context.ts       # Extended with pagination state
│   ├── seq.ts           # Unchanged
│   ├── session.ts       # Unchanged
│   └── errors.ts        # Unchanged
├── collection.ts        # Extended with pagination API
├── documents.ts         # Extended with document-level observer
├── prose.ts             # Simplified (no actor registration)
└── ...

src/server/
├── replicate.ts         # Simplified to 4 exports
├── collection.ts        # Updated factory
└── ...

src/shared/
├── validators.ts        # Extended with new validators
└── ...
```
