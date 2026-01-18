# Migration V2: Schema Normalization & Effect.ts Optimization

## Overview

This migration addresses two major improvements:

1. **Schema Normalization** - Consistent, single-word field names across all tables
2. **Effect.ts Adoption** - Replace ad-hoc async patterns with composable Effect services
3. **Architecture Cleanup** - Consolidate module-level state, mandatory vectors

---

## Phase 1: Schema Field Renaming

### Current → New Field Names

#### `documents` table

| Current      | New        | Reason                        |
| ------------ | ---------- | ----------------------------- |
| `documentId` | `document` | Match sessions table, shorter |
| `crdtBytes`  | `bytes`    | Table name provides context   |

#### `snapshots` table

| Current         | New        | Reason               |
| --------------- | ---------- | -------------------- |
| `documentId`    | `document` | Consistency          |
| `snapshotBytes` | `bytes`    | Redundant prefix     |
| `stateVector`   | `vector`   | Match sessions table |
| `snapshotSeq`   | `seq`      | Redundant prefix     |
| `createdAt`     | `created`  | Shorter              |

#### `sessions` table

| Current     | New       | Reason  |
| ----------- | --------- | ------- |
| `timeoutId` | `timeout` | Shorter |

#### Index names (consistency)

| Current      | New             |
| ------------ | --------------- |
| `collection` | `by_collection` |
| `document`   | `by_document`   |
| `client`     | `by_client`     |
| `connected`  | `by_connected`  |

### New Schema

```typescript
// src/component/schema.ts
export default defineSchema({
  documents: defineTable({
    collection: v.string(),
    document: v.string(),
    bytes: v.bytes(),
    seq: v.number(),
  })
    .index("by_collection", ["collection"])
    .index("by_document", ["collection", "document"])
    .index("by_seq", ["collection", "seq"]),

  snapshots: defineTable({
    collection: v.string(),
    document: v.string(),
    bytes: v.bytes(),
    vector: v.bytes(),
    seq: v.number(),
    created: v.number(),
  }).index("by_document", ["collection", "document"]),

  sessions: defineTable({
    collection: v.string(),
    document: v.string(),
    client: v.string(),
    vector: v.optional(v.bytes()),
    connected: v.boolean(),
    seq: v.number(),
    seen: v.number(),
    user: v.optional(v.string()),
    profile: v.optional(v.object({
      name: v.optional(v.string()),
      color: v.optional(v.string()),
      avatar: v.optional(v.string()),
    })),
    cursor: v.optional(v.object({
      anchor: v.number(),
      head: v.number(),
      field: v.optional(v.string()),
    })),
    active: v.optional(v.number()),
    timeout: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_collection", ["collection"])
    .index("by_document", ["collection", "document"])
    .index("by_client", ["collection", "document", "client"])
    .index("by_connected", ["collection", "document", "connected"]),
});
```

### Files to Update

1. `src/component/schema.ts` - Schema definition
2. `src/component/public.ts` - All mutations/queries using these fields
3. `src/server/storage.ts` - Wrapper functions
4. `src/server/builder.ts` - If referencing field names

---

## Phase 2: Effect.ts Service Architecture

### Current State

We have one Effect.ts service: `CursorService` in `src/client/services/cursor.ts`

```typescript
export class CursorService extends Context.Tag("CursorService")<
  CursorService,
  {
    readonly loadCursor: (collection: string) => Effect.Effect<Cursor, IDBError>;
    readonly saveCursor: (collection: string, cursor: Cursor) => Effect.Effect<void, IDBWriteError>;
    readonly clearCursor: (collection: string) => Effect.Effect<void, IDBError>;
    readonly loadPeerId: (collection: string) => Effect.Effect<string, IDBError | IDBWriteError>;
  }
>() {}
```

### New Services to Create

#### 2.1 `HeartbeatService` - Timer-based presence

```typescript
// src/client/services/heartbeat.ts
import { Effect, Context, Layer, Schedule } from "effect";

export class HeartbeatService extends Context.Tag("HeartbeatService")<
  HeartbeatService,
  {
    readonly start: (config: HeartbeatConfig) => Effect.Effect<void, never, Scope>;
    readonly stop: () => Effect.Effect<void>;
    readonly updateCursor: (position: CursorPosition | null) => Effect.Effect<void>;
  }
>() {}

// Implementation uses Effect.forkScoped for auto-cleanup
export function createHeartbeatLayer(deps: HeartbeatDeps) {
  return Layer.scoped(
    HeartbeatService,
    Effect.gen(function* () {
      let fiber: Fiber.RuntimeFiber<void, never> | null = null;
      let currentCursor: CursorPosition | null = null;

      const sendHeartbeat = Effect.gen(function* () {
        const vector = deps.getVector();
        yield* Effect.tryPromise(() =>
          deps.convexClient.mutation(deps.api.mark, {
            document: deps.document,
            client: deps.client,
            vector,
            cursor: currentCursor,
          })
        );
      });

      return HeartbeatService.of({
        start: (config) =>
          Effect.gen(function* () {
            fiber = yield* Effect.forkScoped(
              Effect.repeat(
                sendHeartbeat,
                Schedule.spaced(config.interval ?? "10 seconds")
              )
            );
          }),

        stop: () =>
          Effect.gen(function* () {
            if (fiber) {
              yield* Fiber.interrupt(fiber);
              fiber = null;
            }
          }),

        updateCursor: (position) =>
          Effect.sync(() => {
            currentCursor = position;
          }),
      });
    })
  );
}
```

#### 2.2 `PresenceService` - Unified presence management

```typescript
// src/client/services/presence.ts
import { Effect, Context, Layer } from "effect";

interface PresenceConfig {
  collection: string;
  document: string;
  client: string;
  convexClient: ConvexClient;
  api: PresenceApi;
  subdocManager: SubdocManager;  // Direct access - no callback!
}

export class PresenceService extends Context.Tag("PresenceService")<
  PresenceService,
  {
    readonly connect: () => Effect.Effect<void, never, Scope>;
    readonly disconnect: () => Effect.Effect<void>;
    readonly updateCursor: (position: CursorPosition | null) => Effect.Effect<void>;
    readonly getOthers: () => Effect.Effect<Map<string, ClientCursor>>;
    readonly subscribe: (cb: () => void) => Effect.Effect<() => void>;
  }
>() {}

export function createPresenceLayer(config: PresenceConfig) {
  return Layer.scoped(
    PresenceService,
    Effect.gen(function* () {
      // Vector is ALWAYS available - subdocManager is injected
      const getVector = () => {
        const subdoc = config.subdocManager.get(config.document);
        return subdoc
          ? Y.encodeStateVector(subdoc).buffer as ArrayBuffer
          : undefined;
      };

      // Heartbeat fiber - auto-cancelled when scope closes
      const heartbeatFiber = yield* Effect.forkScoped(
        Effect.repeat(
          sendHeartbeat(config, getVector),
          Schedule.spaced("10 seconds")
        )
      );

      // Visibility handling
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const handler = () => { /* visibility logic */ };
          document.addEventListener("visibilitychange", handler);
          return handler;
        }),
        (handler) => Effect.sync(() => {
          document.removeEventListener("visibilitychange", handler);
        })
      );

      return PresenceService.of({
        // ... implementation
      });
    })
  );
}
```

#### 2.3 `SyncService` - Stream subscription and retry logic

```typescript
// src/client/services/sync.ts
import { Effect, Context, Layer, Schedule } from "effect";

const retryPolicy = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.upTo("30 seconds"),
  Schedule.intersect(Schedule.recurs(5))
);

export class SyncService extends Context.Tag("SyncService")<
  SyncService,
  {
    readonly subscribe: () => Effect.Effect<void, NetworkError, Scope>;
    readonly recover: () => Effect.Effect<Cursor, RecoveryError>;
    readonly compact: (documentId: string) => Effect.Effect<CompactResult, NetworkError>;
  }
>() {}

export function createSyncLayer(config: SyncConfig) {
  return Layer.scoped(
    SyncService,
    Effect.gen(function* () {
      return SyncService.of({
        subscribe: () =>
          Effect.gen(function* () {
            // Convex subscription with retry
            yield* Effect.acquireRelease(
              Effect.tryPromise(() =>
                config.convexClient.onUpdate(config.api.stream, ...)
              ).pipe(Effect.retry(retryPolicy)),
              (unsub) => Effect.sync(() => unsub())
            );
          }),

        recover: () =>
          Effect.gen(function* () {
            const localVector = Y.encodeStateVector(config.subdocManager.rootDoc);
            const response = yield* Effect.tryPromise(() =>
              config.convexClient.query(config.api.recovery, {
                clientStateVector: localVector.buffer,
              })
            );
            return response.cursor ?? 0;
          }),

        compact: (documentId) =>
          Effect.tryPromise(() =>
            config.convexClient.mutation(config.api.compact, {
              collection: config.collection,
              documentId,
            })
          ).pipe(Effect.retry(retryPolicy)),
      });
    })
  );
}
```

### 2.4 `CollectionContext` - Consolidated state

Replace 8+ module-level Maps with single context:

```typescript
// src/client/services/context.ts
interface CollectionContext {
  collection: string;
  subdocManager: SubdocManager;
  convexClient: ConvexClient;
  api: ConvexCollectionApi;
  peerId: string;
  persistence: Persistence;
  proseFields: Set<string>;
  mutex: ReturnType<typeof createMutex>;
}

const contexts = new Map<string, CollectionContext>();

export function getContext(collection: string): CollectionContext {
  const ctx = contexts.get(collection);
  if (!ctx) throw new Error(`Collection ${collection} not initialized`);
  return ctx;
}

export function initContext(config: CollectionConfig): CollectionContext {
  const ctx: CollectionContext = {
    collection: config.collection,
    subdocManager: createSubdocManager(config.collection),
    convexClient: config.convexClient,
    api: config.api,
    peerId: crypto.randomUUID(),
    persistence: config.persistence,
    proseFields: new Set(extractProseFields(config.schema)),
    mutex: createMutex(),
  };
  contexts.set(config.collection, ctx);
  return ctx;
}
```

---

## Phase 3: Architecture Improvements

### 3.1 Remove `CursorTracker` class, replace with `PresenceService`

**Current (class-based, optional vector):**

```typescript
// src/client/cursor-tracker.ts
export class CursorTracker {
  constructor(config: {
    getVector?: () => ArrayBuffer | undefined;  // Optional!
    // ...
  }) {}
}
```

**New (Effect service, mandatory vector):**

```typescript
// src/client/services/presence.ts
// PresenceService has direct SubdocManager access
// Vector is ALWAYS sent - no optional callback
```

### 3.2 Break up the 400-line sync IIFE in `collection.ts`

**Current structure:**

```typescript
// collection.ts lines 650-950
sync: {
  sync(params) {
    // 300+ lines of inline async code
    (async () => {
      // persistence setup
      // recovery
      // subscription
      // polling
      // error handling
    })();
  }
}
```

**New structure:**

```typescript
// collection.ts
sync: {
  sync(params) {
    const program = Effect.gen(function* () {
      const ctx = yield* CollectionContext;
      const sync = yield* SyncService;
      const presence = yield* PresenceService;

      yield* sync.recover();
      yield* sync.subscribe();
      yield* presence.connect();
    });

    const layer = Layer.mergeAll(
      createSyncLayer(config),
      createPresenceLayer(config),
    );

    Effect.runFork(program.pipe(Effect.provide(layer)));
  }
}
```

---

## Phase 4: Implementation Order

### Step 1: Schema Changes (Breaking)

- [ ] Update `src/component/schema.ts`
- [ ] Update `src/component/public.ts` (all field references)
- [ ] Update `src/server/storage.ts`
- [ ] Run build, fix any remaining references

### Step 2: CollectionContext Consolidation

- [ ] Create `src/client/services/context.ts`
- [ ] Migrate module-level Maps to CollectionContext
- [ ] Update `collection.ts` to use context

### Step 3: PresenceService (replaces CursorTracker)

- [ ] Create `src/client/services/presence.ts`
- [ ] Implement with direct SubdocManager access
- [ ] Mandatory vector in heartbeats
- [ ] Visibility handling via Effect.acquireRelease
- [ ] Remove `src/client/cursor-tracker.ts`

### Step 4: SyncService

- [ ] Create `src/client/services/sync.ts`
- [ ] Extract recovery logic
- [ ] Extract subscription logic
- [ ] Add composable retry policies

### Step 5: Refactor collection.ts sync IIFE

- [ ] Replace inline async with Effect.gen
- [ ] Compose services via Layer
- [ ] Remove cleanup functions Map (Effect handles cleanup)

---

## Files Changed Summary

### New Files

- `src/client/services/context.ts` - CollectionContext
- `src/client/services/presence.ts` - PresenceService (replaces CursorTracker)
- `src/client/services/sync.ts` - SyncService
- `src/client/services/heartbeat.ts` - HeartbeatService (optional, can be part of presence)

### Modified Files

- `src/component/schema.ts` - Field renames
- `src/component/public.ts` - Field renames + index name updates
- `src/server/storage.ts` - Field renames
- `src/client/collection.ts` - Use new services, remove module Maps
- `src/client/index.ts` - Export changes

### Deleted Files

- `src/client/cursor-tracker.ts` - Replaced by PresenceService

---

## Unix Philosophy Alignment

| Principle            | Implementation                           |
| -------------------- | ---------------------------------------- |
| Do one thing well    | Each service has single responsibility   |
| Compose simple parts | Effect.gen + Layer composition           |
| One obvious way      | Mandatory vectors, no optional callbacks |
| Resource safety      | Effect.acquireRelease for all cleanup    |
| Predictable naming   | Single-word fields, `by_*` indexes       |

---

## Testing Strategy

1. **Unit tests** for each new service
2. **Integration test** for full sync flow with Effect
3. **Migration test** to verify schema changes work with existing data

---

## Rollback Plan

If issues arise:

1. Schema changes can be reverted by restoring old field names
2. Effect services are additive - old code paths can remain as fallback
3. CursorTracker can be kept alongside PresenceService during transition

---

## Phase 5: Parameter Naming Consistency

### Goal

All function parameters should follow the same single-word noun pattern as the public API:

```typescript
// Public API (gold standard)
mark({ collection, document, client, vector, cursor })
compact({ collection, document })
stream({ collection, cursor, limit })
```

### Parameter Rename Mapping

#### Category A: ID Parameters (79 occurrences)

| File            | Current      | New        |
| --------------- | ------------ | ---------- |
| `collection.ts` | `documentId` | `document` |
| `subdocs.ts`    | `documentId` | `document` |
| `prose.ts`      | `documentId` | `document` |
| `storage.ts`    | `documentId` | `document` |
| `public.ts`     | `documentId` | `document` |
| `merge.ts`      | `documentId` | `document` |

#### Category B: Bytes Parameters (20 occurrences)

| File            | Current         | New        |
| --------------- | --------------- | ---------- |
| `collection.ts` | `crdtBytes`     | `bytes`    |
| `storage.ts`    | `crdtBytes`     | `bytes`    |
| `public.ts`     | `crdtBytes`     | `bytes`    |
| `storage.ts`    | `snapshotBytes` | `snapshot` |
| `public.ts`     | `snapshotBytes` | `snapshot` |

#### Category C: Vector Parameters (6 occurrences)

| File            | Current             | New      | Notes          |
| --------------- | ------------------- | -------- | -------------- |
| `collection.ts` | `clientStateVector` | `vector` | Recovery input |
| `storage.ts`    | `clientStateVector` | `vector` | Recovery input |
| `public.ts`     | `clientStateVector` | `vector` | Recovery input |
| `storage.ts`    | `stateVector`       | `vector` | Compaction     |

#### Category D: Config Parameters (4 occurrences)

| File                | Current              | New        |
| ------------------- | -------------------- | ---------- |
| `collection.ts`     | `undoCaptureTimeout` | `timeout`  |
| `cursor-tracker.ts` | `heartbeatInterval`  | `interval` |
| `prose.ts`          | `debounceMs`         | `debounce` |
| `storage.ts`        | `peerTimeout`        | `timeout`  |

#### Category E: Material Parameters (4 occurrences)

| File            | Current           | New        |
| --------------- | ----------------- | ---------- |
| `collection.ts` | `materializedDoc` | `material` |
| `storage.ts`    | `materializedDoc` | `material` |

### Edge Cases

#### Multiple Vectors (Recovery)

```typescript
// Input param is `vector` (client sends theirs)
// Output is also `vector` (server returns theirs)
recovery({ vector }) → { vector, diff, cursor }
```

#### Config Object Properties

Flat single-word unless collision:

```typescript
// Simple (no collision)
{ timeout: 500, interval: 10000, debounce: 1000 }

// Grouped (collision)
{ undo: { timeout: 500 }, compaction: { timeout: "24h" } }
```

### Summary

| Category                       | Count   | Effort     |
| ------------------------------ | ------- | ---------- |
| `documentId` → `document`      | 79      | Medium     |
| `crdtBytes` → `bytes`          | 20      | Low        |
| Vector params                  | 6       | Low        |
| Config properties              | 4       | Low        |
| `materializedDoc` → `material` | 4       | Low        |
| **Total**                      | **113** | **Medium** |

---

## Complete Naming Convention Reference

### Functions

| Pattern    | Convention    | Examples                                  |
| ---------- | ------------- | ----------------------------------------- |
| Factories  | `<noun>()`    | `subdocs()`, `mutex()`, `layer()`         |
| Accessors  | `<noun>()`    | `cursor()`, `seq()`, `logger()`           |
| Transforms | `<verb>()`    | `encode()`, `decode()`, `serialize()`     |
| Predicates | `is<Noun>()`  | `isProse()`, `isDoc()`, `isFragment()`    |
| Actions    | `<verb>()`    | `apply()`, `merge()`, `observe()`         |
| Handlers   | `on<Event>()` | `onSnapshot()`, `onDelta()`, `onUpdate()` |
| Internal   | `_<name>()`   | `_serialize()`, `_reset()`                |

### Classes

| Pattern  | Convention         | Examples                                |
| -------- | ------------------ | --------------------------------------- |
| Managers | `<Nouns>` (plural) | `Subdocs`, `Cursors`                    |
| Services | `<Noun>`           | `Cursor`, `Storage`, `Sync`             |
| Stores   | `<Backend>Store`   | `SqliteStore`, `MemoryStore`            |
| Errors   | `<Noun>Error`      | `WriteError`, `SyncError`, `ProseError` |

### Types/Interfaces

| Pattern    | Convention      | Examples                           |
| ---------- | --------------- | ---------------------------------- |
| Config     | `<Noun>Config`  | `CollectionConfig`, `CursorConfig` |
| Options    | `<Noun>Options` | `SyncOptions`, `CompactOptions`    |
| State      | Plain noun      | `Cursor`, `Position`, `Profile`    |
| Operations | `<Noun>Ops`     | `CursorOps`, `SyncOps`             |

### Parameters

| Pattern | Convention  | Examples                           |
| ------- | ----------- | ---------------------------------- |
| IDs     | Single noun | `document`, `client`, `collection` |
| Data    | Single noun | `bytes`, `vector`, `cursor`        |
| Counts  | Single noun | `limit`, `offset`, `seq`           |
| Config  | Single noun | `timeout`, `interval`, `debounce`  |

### Effect.ts Specific

```typescript
// Service tag
class Cursor extends Context.Tag("Cursor")<Cursor, CursorOps>() {}

// Operations interface
interface CursorOps {
  readonly load: (collection: string) => Effect<number, ReadError>;
  readonly save: (collection: string, cursor: number) => Effect<void, WriteError>;
}

// Layer factory
function cursorLayer(kv: KV): Layer.Layer<Cursor> { ... }
```

---

## Implementation Checklist

### Phase 1: Schema Fields

- [ ] `src/component/schema.ts` - Rename fields
- [ ] `src/component/public.ts` - Update all field references
- [ ] `src/server/storage.ts` - Update field references

### Phase 2: Function/Class Renames

- [ ] `src/client/cursor-tracker.ts` → Delete (replaced by PresenceService)
- [ ] `src/client/subdocs.ts` - Rename `createSubdocManager` → `subdocs`
- [ ] `src/client/services/cursor.ts` - Rename `CursorService` → `Cursor`
- [ ] `src/client/collection.ts` - Update all references

### Phase 3: Parameter Renames

- [ ] `documentId` → `document` (all files)
- [ ] `crdtBytes` → `bytes` (all files)
- [ ] `clientStateVector` → `vector` (all files)
- [ ] Config properties (timeout, interval, debounce)

### Phase 4: Effect.ts Services

- [ ] Create `src/client/services/presence.ts`
- [ ] Create `src/client/services/sync.ts`
- [ ] Create `src/client/services/context.ts`
- [ ] Refactor `collection.ts` sync IIFE

### Phase 5: Cleanup

- [ ] Run `bun run build`
- [ ] Run `bun run lint:fix`
- [ ] Run `bun run test`
- [ ] Update examples if needed

---

---

## Phase 6: File Naming & Directory Structure (REVISED)

### The Rule

```
ALL FILES: lowercase, single word, no hyphens, no capitals
ALL DIRS:  lowercase, single word
```

This is the Unix way. No exceptions.

### Current Issues

```
src/client/
├── cursor-tracker.ts    # ❌ hyphen, DELETE (replaced by services/presence.ts)
├── prose-schema.ts      # ❌ hyphen, MERGE into prose.ts
├── replicate.ts         # ❌ vague name → ops.ts

src/component/
├── public.ts            # ❌ vague → mutations.ts

src/server/
├── builder.ts           # ❌ vague → collection.ts
├── storage.ts           # ❌ vague → replicate.ts
```

### File Changes

| Action | Old                        | New                      | Reason                             |
| ------ | -------------------------- | ------------------------ | ---------------------------------- |
| DELETE | `client/cursor-tracker.ts` | -                        | Replaced by `services/presence.ts` |
| MERGE  | `client/prose-schema.ts`   | Into `client/prose.ts`   | Same concern                       |
| RENAME | `client/replicate.ts`      | `client/ops.ts`          | Clearer                            |
| RENAME | `component/public.ts`      | `component/mutations.ts` | Descriptive                        |
| RENAME | `server/builder.ts`        | `server/collection.ts`   | Matches export                     |
| RENAME | `server/storage.ts`        | `server/replicate.ts`    | Matches export                     |

### Files That Stay (Already Correct)

```
✅ client/subdocs.ts      # lowercase, single word
✅ client/prose.ts        # lowercase, single word
✅ client/merge.ts        # lowercase, single word
✅ client/errors.ts       # lowercase, single word
✅ client/logger.ts       # lowercase, single word
✅ client/index.ts        # lowercase, single word
✅ client/services/cursor.ts
✅ client/persistence/*   # all correct
✅ component/schema.ts
✅ component/logger.ts
✅ server/schema.ts
✅ server/index.ts
✅ shared/*
```

### Split `collection.ts` (950+ lines → directory)

```
client/collection/
├── index.ts      # barrel
├── sync.ts       # sync logic
├── mutations.ts  # insert/update/delete
├── options.ts    # config options
└── types.ts      # interfaces
```

### New Services

```
client/services/
├── cursor.ts     # ✅ exists
├── presence.ts   # NEW (replaces cursor-tracker.ts)
├── sync.ts       # NEW
└── context.ts    # NEW
```

### Final Structure

```
src/
├── client/
│   ├── collection/
│   │   ├── index.ts
│   │   ├── sync.ts
│   │   ├── mutations.ts
│   │   ├── options.ts
│   │   └── types.ts
│   ├── persistence/
│   │   ├── custom.ts
│   │   ├── index.ts
│   │   ├── indexeddb.ts
│   │   ├── memory.ts
│   │   ├── sqlite/
│   │   │   ├── browser.ts
│   │   │   ├── native.ts
│   │   │   └── schema.ts
│   │   └── types.ts
│   ├── services/
│   │   ├── context.ts
│   │   ├── cursor.ts
│   │   ├── presence.ts
│   │   └── sync.ts
│   ├── subdocs.ts
│   ├── prose.ts          # includes prose-schema logic
│   ├── merge.ts
│   ├── ops.ts            # was replicate.ts
│   ├── errors.ts
│   ├── logger.ts
│   └── index.ts
│
├── component/
│   ├── _generated/
│   ├── convex.config.ts
│   ├── mutations.ts      # was public.ts
│   ├── schema.ts
│   └── logger.ts
│
├── server/
│   ├── collection.ts     # was builder.ts
│   ├── replicate.ts      # was storage.ts
│   ├── schema.ts
│   └── index.ts
│
└── shared/
    ├── types.ts
    └── index.ts
```

### Summary

| Change | Count |
| ------ | ----- |
| DELETE | 1     |
| MERGE  | 1     |
| RENAME | 4     |
| SPLIT  | 1 → 5 |
| NEW    | 3     |

### The Pattern

```
file.ts     ← one word, lowercase
dir/        ← one word, lowercase
dir/file.ts ← one word each, lowercase
```

No PascalCase. No camelCase. No hyphens. Just lowercase words.

---

## Status: Completed Items

### ✅ Completed

- Phase 1: Schema field renames (`document`, `bytes`, `vector`, `seq`, `created`)
- Phase 2: Effect.ts services (`context.ts`, `cursor.ts`, `presence.ts`)
- Phase 3: Architecture cleanup (`CollectionContext` integration)
- Phase 5: Parameter naming consistency (`documentId`→`document`, `crdtBytes`→`bytes`)
- Phase 6: File renames (`ops.ts`, `mutations.ts`, `collection.ts`, `replicate.ts`)
- Deleted `cursor-tracker.ts` (replaced by `services/presence.ts`)
- Merged `prose-schema.ts` into `prose.ts`
- Renamed `CursorService`→`Cursor`, `type Cursor`→`type Seq`
- **All module-level Maps consolidated into `CollectionContext`**:
  - Moved 9 Maps from `collection.ts` (subdocManagers, undoConfig, mutex, etc.)
  - Moved 7 Maps from `prose.ts` (applyingFromServer, debounceTimers, pendingState, etc.)
  - Moved `cleanupFunctions` and `fragmentUndoManagers` to context

### 🔄 Deferred: SyncService Integration

`services/sync.ts` is implemented with Effect-based `Sync` service providing:

- `subscribe()` - Convex subscription with retry policies
- `recover()` - Recovery logic with vector comparison
- `compact()` - Compaction trigger
- `ack()` - Acknowledgment sending

**Current state**: The file exists but is not yet integrated into `collection.ts`. The inline async sync logic works correctly; Effect-based refactoring is deferred to avoid risk.

**To integrate later**:

1. Replace the ~300-line async IIFE in `collection.ts` with `Effect.gen`
2. Compose `SyncService` via Layer
3. Use `Effect.acquireRelease` for cleanup

### 📋 Future Improvements

- Split `collection.ts` (~930 lines) into `collection/` directory
- Integrate `SyncService` into collection.ts
