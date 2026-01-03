# Signals: Pagination + Unified Actor Architecture

> **Status:** Proposal  
> **Author:** Replicate Team  
> **Date:** January 2026

## Executive Summary

This document outlines a comprehensive architectural enhancement to the Replicate library that introduces:

1. **Convex Pagination** - Cursor-based pagination for SSR and infinite scroll
2. **Unified Actor Model** - All document changes (not just prose) go through actors
3. **Actor-Based Recovery** - Replace bulk recovery with per-document actor reconciliation
4. **Priority Queue System** - Visible documents sync first, background the rest

These changes will dramatically improve performance for:
- Large datasets (1000+ documents)
- Reconnecting clients (offline → online)
- SSR hydration (first paint with minimal data)
- Infinite scroll UX (load on demand)

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Pagination Design](#2-pagination-design)
3. [Unified Actor Model](#3-unified-actor-model)
4. [Actor-Based Recovery](#4-actor-based-recovery)
5. [Priority Queue System](#5-priority-queue-system)
6. [API Reference](#6-api-reference)
7. [Implementation Phases](#7-implementation-phases)
8. [Migration Guide](#8-migration-guide)

---

## 1. Current Architecture Analysis

### 1.1 Current Data Flow

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

### 1.2 Problems with Current Approach

| Issue | Impact | Severity |
|-------|--------|----------|
| Prose-only actors | Inconsistent sync behavior, special cases | High |
| Bulk recovery | Memory spikes, slow reconnection, blocks UI | High |
| No pagination | SSR loads entire dataset, slow first paint | High |
| Direct mutations | No batching for field changes, excessive API calls | Medium |
| No priority ordering | Background docs compete with visible ones | Medium |

### 1.3 Current Actor Implementation

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

## 2. Pagination Design

### 2.1 Convex Pagination API

Convex uses **cursor-based pagination** with the following primitives:

```typescript
// Server-side
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

### 2.2 Server API: Paginated Material Query

**New query:** `materialPaginated`

```typescript
// src/server/replicate.ts

createMaterialPaginatedQuery(opts?: {
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
      cursor: v.optional(v.number()),  // Max seq for recovery
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
        cursor: maxSeq > 0 ? maxSeq : undefined,
        crdt,
      };
    },
  });
}
```

### 2.3 Server API Export

```typescript
// src/server/replicate.ts - Updated collection.create return

export const {
  // Existing
  stream,
  material,
  insert,
  update,
  remove,
  recovery,
  mark,
  compact,
  sessions,
  presence,
  
  // New
  materialPaginated,  // Paginated SSR query
} = collection.create<Doc<"intervals">>(components.replicate, "intervals");
```

### 2.4 Client Configuration API

**Goal:** Consistent DX for configuring pagination on both SSR and client.

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
  config: () => Omit<LazyCollectionConfig<T>, "material">;
  
  // New: Pagination configuration
  pagination?: PaginationConfig;
}

// Usage
export const intervals = collection.create(schema, "intervals", {
  persistence: pglite,
  config: () => ({
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.intervals,
    getKey: (interval) => interval.id,
  }),
  pagination: {
    pageSize: 25,
    ssrPages: 2,           // Load first 50 items on SSR
    ssrIncludeCRDT: true,
    infiniteScroll: true,
    preloadThreshold: 5,
  },
});
```

### 2.5 SSR Hydration Flow

**Server (TanStack Start / SvelteKit / Next.js):**

```typescript
// routes/index.tsx (TanStack Start example)

export const Route = createFileRoute("/")({
  loader: async () => {
    const convex = createConvexHttpClient(CONVEX_URL);
    
    // Fetch first 2 pages with CRDT state
    const page1 = await convex.query(api.intervals.materialPaginated, {
      paginationOpts: { numItems: 25, cursor: null },
      includeCRDT: true,
    });
    
    const page2 = !page1.isDone
      ? await convex.query(api.intervals.materialPaginated, {
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
        seq: Math.max(page1.cursor ?? 0, page2?.cursor ?? 0),
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
  
  // 4. Start stream from SSR cursor (skip already-loaded deltas)
  this.startStream(material.seq);
  
  // 5. Ready immediately - no loading state for SSR docs!
  this.markReady();
}
```

### 2.6 Client Pagination API

```typescript
// src/client/collection.ts

export interface LazyCollection<T extends object> {
  // Existing
  init(material?: Materialized<T>): Promise<void>;
  get(): Collection<T>;
  readonly $docType?: T;
  
  // New: Pagination
  readonly pagination: {
    /** Load next page of documents */
    loadMore(): Promise<PaginatedPage<T>>;
    
    /** Current pagination status */
    readonly status: PaginationStatus;
    
    /** Subscribe to status changes */
    onStatusChange(callback: (status: PaginationStatus) => void): () => void;
    
    /** Total loaded document count */
    readonly loadedCount: number;
    
    /** Whether more pages are available */
    readonly hasMore: boolean;
  };
}

type PaginationStatus =
  | "idle"              // Initial state
  | "loading"           // Loading a page
  | "ready"             // Page loaded, more available
  | "exhausted";        // No more pages

interface PaginatedPage<T> {
  documents: T[];
  isDone: boolean;
}
```

### 2.7 Infinite Scroll Integration

```typescript
// React example with TanStack Virtual

function IntervalList() {
  const collection = useIntervals();
  const { status, loadMore, hasMore } = collection.pagination;
  
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
      hasMore &&
      status === "ready"
    ) {
      loadMore();
    }
  }, [virtualizer.getVirtualItems(), hasMore, status]);
  
  return (
    <div ref={parentRef} style={{ height: "100vh", overflow: "auto" }}>
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <IntervalRow key={item.key} interval={documents[item.index]} />
        ))}
      </div>
      {status === "loading" && <LoadingSpinner />}
    </div>
  );
}
```

---

## 3. Unified Actor Model

### 3.1 Design Goals

1. **All changes through actors** - Prose fields, regular fields, deletes
2. **Single sync path** - No special cases
3. **Consistent batching** - All changes debounced
4. **Unified pending state** - One source of truth per document

### 3.2 New Message Types

```typescript
// src/client/services/actor.ts

export type DocumentMessage =
  // Existing
  | { readonly _tag: "LocalChange" }
  | { readonly _tag: "ExternalUpdate" }
  | { readonly _tag: "Shutdown"; readonly done: Deferred.Deferred<void, never> }
  
  // New
  | { readonly _tag: "Reconcile"; readonly done: Deferred.Deferred<ReconcileResult, SyncError> }
  | { readonly _tag: "FieldChange"; readonly field: string; readonly value: unknown }
  | { readonly _tag: "Delete" };

interface ReconcileResult {
  localChanges: number;   // Changes pushed to server
  remoteChanges: number;  // Changes received from server
  conflicts: number;      // Merge conflicts (CRDT resolves automatically)
}
```

### 3.3 Actor State

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
  readonly pendingFields: Set<string>;  // Fields with unsaved changes
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

### 3.4 Unified Sync Function

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
  
  // Single mutation handles all change types
  yield* Effect.tryPromise({
    try: () => syncFn({ bytes, material }),
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
  }));
});
```

### 3.5 Document-Level Observer

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

### 3.6 Integration with TanStack DB

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
    
    // Register actor for this document
    const syncFn = createSyncFn(docId, ydoc, ymap, collection);
    await runWithRuntime(runtime, actorManager.register(docId, ydoc, syncFn));
    
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
    
    // Create delete marker in Yjs
    const deleteMarker = createDeleteDelta(docId);
    
    // Notify actor to sync the delete
    await runWithRuntime(runtime, actorManager.onLocalChange(docId));
  },
});
```

---

## 4. Actor-Based Recovery

### 4.1 Current Recovery (Problems)

```typescript
// Current: Bulk recovery on reconnect
const recoverFromServer = async () => {
  // 1. Fetch ALL deltas since last cursor
  const result = await convexClient.query(api.stream, {
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

### 4.2 Actor-Based Recovery (Solution)

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

### 4.3 Reconnection Flow

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

### 4.4 Benefits of Actor-Based Recovery

| Aspect | Bulk Recovery | Actor Recovery |
|--------|---------------|----------------|
| Memory | Spikes (all deltas at once) | Constant (per-doc) |
| UI Blocking | Yes (entire recovery) | No (incremental) |
| Priority | None | Visible first |
| Failure | All-or-nothing | Per-document retry |
| Resume | Restart from beginning | Continue where left off |
| Bandwidth | Redundant (re-fetch known) | Minimal (vector diff) |

---

## 5. Priority Queue System

### 5.1 Queue Architecture

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

### 5.2 Priority Assignment

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

### 5.3 Queue Processor

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
    yield* Effect.forkScoped(
      processQueue(criticalQueue, config.critical),
    );
    yield* Effect.forkScoped(
      processQueue(highQueue, config.high),
    );
    yield* Effect.forkScoped(
      processQueue(normalQueue, config.normal),
    );
    yield* Effect.forkScoped(
      processQueue(lowQueue, config.low),
    );
    
    return {
      enqueue: (sync: QueuedSync) => {
        switch (sync.priority) {
          case "critical":
            return Queue.offer(criticalQueue, sync);
          case "high":
            return Queue.offer(highQueue, sync);
          case "normal":
            return Queue.offer(normalQueue, sync);
          case "low":
            return Queue.offer(lowQueue, sync);
        }
      },
      
      // Promote document to higher priority
      promote: (documentId: string, priority: ActorPriority) =>
        Effect.gen(function* () {
          // Move from current queue to target queue
          // Implementation details...
        }),
    };
  });
```

### 5.4 Visibility Detection

```typescript
// src/client/services/visibility.ts

export const createVisibilityTracker = (): VisibilityTracker => {
  const visibleDocs = new Set<string>();
  const observers = new Map<string, IntersectionObserver>();
  
  return {
    /** Register element for visibility tracking */
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
    
    /** Check if document is currently visible */
    isVisible: (documentId: string) => visibleDocs.has(documentId),
    
    /** Get all visible document IDs */
    getVisible: () => Array.from(visibleDocs),
  };
};
```

### 5.5 Integration with Actors

```typescript
// src/client/services/manager.ts

export const createActorManager = (
  config: ActorManagerConfig = {},
): Effect.Effect<ActorManager, never, Scope.Scope> =>
  Effect.gen(function* () {
    // ... existing setup ...
    
    const priorityQueue = yield* createPriorityQueue(config.queue);
    const visibilityTracker = config.visibilityTracker ?? createVisibilityTracker();
    
    const manager: ActorManager = {
      // ... existing methods ...
      
      onLocalChange: (documentId) =>
        Effect.gen(function* () {
          const actor = yield* manager.get(documentId);
          if (!actor) return;
          
          // Determine priority based on visibility
          const priority = determinePriority(
            documentId,
            yield* Ref.get(actor.stateRef),
            { isVisible: visibilityTracker.isVisible },
          );
          
          // Enqueue with priority
          yield* priorityQueue.enqueue({
            documentId,
            priority,
            actor,
            type: "sync",
          });
        }),
      
      /** Mark document as visible (promotes priority) */
      markVisible: (documentId: string, element: HTMLElement) => {
        return visibilityTracker.observe(documentId, element);
      },
    };
    
    return manager;
  });
```

---

## 6. API Reference

### 6.1 Server API

```typescript
// Collection creation (server-side)
const { 
  // Existing
  stream,           // Real-time delta stream
  material,         // Full dataset (deprecated for large collections)
  insert,           // Insert mutation
  update,           // Update mutation
  remove,           // Remove mutation
  recovery,         // Per-document recovery query
  mark,             // Mark client cursor
  compact,          // Compaction mutation
  sessions,         // Active sessions query
  presence,         // Presence mutation
  
  // New
  materialPaginated,  // Paginated SSR query
} = collection.create<T>(component, "tableName", options);

// materialPaginated signature
materialPaginated(args: {
  paginationOpts: { numItems: number; cursor: string | null };
  includeCRDT?: boolean;
}): Promise<{
  page: T[];
  isDone: boolean;
  continueCursor: string;
  cursor?: number;
  crdt?: Record<string, { bytes: ArrayBuffer; seq: number }>;
}>
```

### 6.2 Client API

```typescript
// Collection creation (client-side)
const collection = collection.create(schema, "tableName", {
  persistence: () => pglite(),
  config: () => ({
    convexClient,
    api: api.tableName,
    getKey: (doc) => doc.id,
  }),
  pagination: {
    pageSize: 25,
    ssrPages: 2,
    ssrIncludeCRDT: true,
    infiniteScroll: true,
    preloadThreshold: 5,
  },
  actors: {
    debounceMs: 200,
    maxRetries: 3,
    priority: {
      recentThreshold: 5000,
    },
  },
});

// Type extraction
type Interval = collection.Doc<typeof intervals>;

// Instance methods
interface LazyCollection<T> {
  init(material?: PaginatedMaterial<T>): Promise<void>;
  get(): Collection<T>;
  
  pagination: {
    loadMore(): Promise<PaginatedPage<T>>;
    status: PaginationStatus;
    hasMore: boolean;
    loadedCount: number;
    onStatusChange(cb: (status: PaginationStatus) => void): () => void;
  };
  
  actors: {
    getPending(documentId: string): boolean;
    onPendingChange(documentId: string, cb: (pending: boolean) => void): () => void;
    reconcile(documentId: string): Promise<ReconcileResult>;
    reconcileAll(): Promise<ReconcileResult[]>;
    markVisible(documentId: string, element: HTMLElement): () => void;
  };
}
```

### 6.3 Actor Messages

```typescript
type DocumentMessage =
  | { _tag: "LocalChange" }                    // Field/prose changed locally
  | { _tag: "ExternalUpdate" }                 // Server pushed update
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

## 7. Implementation Phases

### Phase 1: Pagination Foundation (3-4 days)

**Deliverables:**
- [ ] `materialPaginated` query on server
- [ ] `PaginationConfig` interface on client
- [ ] `collection.pagination` API
- [ ] SSR hydration with pagination
- [ ] Basic infinite scroll support

**Files to modify:**
- `src/server/replicate.ts` - Add `createMaterialPaginatedQuery`
- `src/client/collection.ts` - Add pagination config and state
- `src/shared/validators.ts` - Add pagination validators

### Phase 2: Unified Actor Model (4-5 days)

**Deliverables:**
- [ ] New message types (`Reconcile`, `SetPriority`)
- [ ] Document-level observer (not just prose)
- [ ] Remove prose-specific actor registration
- [ ] TanStack DB mutation integration with actors

**Files to modify:**
- `src/client/services/actor.ts` - Extend message types, add reconcile
- `src/client/services/manager.ts` - Add reconcile, priority methods
- `src/client/documents.ts` - Add document-level observer
- `src/client/prose.ts` - Simplify, remove actor registration
- `src/client/collection.ts` - Wire mutations through actors

### Phase 3: Priority Queue System (2-3 days)

**Deliverables:**
- [ ] Priority queue with 4 levels
- [ ] Visibility tracker (IntersectionObserver)
- [ ] Priority-based debounce configuration
- [ ] Queue processor with concurrency limits

**Files to create:**
- `src/client/services/queue.ts` - Priority queue implementation
- `src/client/services/priority.ts` - Priority determination
- `src/client/services/visibility.ts` - Visibility tracking

### Phase 4: Actor-Based Recovery (2-3 days)

**Deliverables:**
- [ ] `Reconcile` message handler in actor
- [ ] Reconnection handler using actors
- [ ] Priority-ordered recovery (visible first)
- [ ] Remove bulk recovery code

**Files to modify:**
- `src/client/services/actor.ts` - Add `handleReconcile`
- `src/client/collection.ts` - Replace bulk recovery with actor reconciliation

### Phase 5: Testing & Examples (2-3 days)

**Deliverables:**
- [ ] Unit tests for pagination
- [ ] Unit tests for actor reconciliation
- [ ] Integration tests for recovery
- [ ] Update SvelteKit example with infinite scroll
- [ ] Update TanStack Start example with SSR pagination

---

## 8. Migration Guide

### 8.1 Breaking Changes

**None** - All changes are additive. Existing APIs continue to work.

### 8.2 Deprecations

| Deprecated | Replacement | Timeline |
|------------|-------------|----------|
| `material()` for large datasets | `materialPaginated()` | v2.0 |
| Bulk recovery | Actor-based recovery | Automatic |

### 8.3 Upgrade Steps

**Step 1: Enable pagination (optional)**

```typescript
// Before
export const intervals = collection.create(schema, "intervals", {
  persistence: pglite,
  config: () => ({ ... }),
});

// After
export const intervals = collection.create(schema, "intervals", {
  persistence: pglite,
  config: () => ({ ... }),
  pagination: {           // New: optional
    pageSize: 25,
    ssrPages: 2,
  },
});
```

**Step 2: Update SSR loader (if using pagination)**

```typescript
// Before
const material = await convex.query(api.intervals.material, {});

// After
const page1 = await convex.query(api.intervals.materialPaginated, {
  paginationOpts: { numItems: 50, cursor: null },
  includeCRDT: true,
});
```

**Step 3: Add infinite scroll (optional)**

```typescript
// In component
const { loadMore, hasMore, status } = intervals.pagination;

<button onClick={loadMore} disabled={!hasMore || status === "loading"}>
  Load More
</button>
```

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
├── replicate.ts         # Extended with materialPaginated
└── ...

src/shared/
├── validators.ts        # Extended with pagination validators
└── ...
```
