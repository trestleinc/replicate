# Migration Plan: `cursor` Branch

## Overview

Create a new branch off `main` that:

1. **Removes all Level dependencies** (the React Native blocker)
2. **Simplifies to SQLite-only storage** (sql.js for browser, op-sqlite for RN)
3. **Implements cursor-based sync** using monotonically increasing sequence numbers
4. **Adds peer tracking** for safe compaction (no data loss for slow peers)
5. **Client-driven compaction** with server hints when documents exceed size threshold

## Why This Migration?

### The Problem

The main branch uses `y-leveldb` + `abstract-level` + `browser-level` for persistence. These Level dependencies have native bindings that **break React Native compatibility**.

### The Solution

- Replace Level-based storage with **direct SQLite storage**
- Use `Y.encodeStateAsUpdate()` / `Y.applyUpdate()` to persist Y.Doc state as blobs
- Use **cursor-based sync** (monotonically increasing version numbers) instead of `_creationTime`
- Keep **state vector sync** for recovery/cold start scenarios

### Why Cursor Instead of Timestamp?

From Convex docs:
> "Currently the 'check if there are new changes' uses the previous `_creationTime` as the cursor. Unfortunately, the previous query could have fetched results before an in-progress mutation commits, which could have started prior to what the latest document's `_creationTime` shows, meaning the next check will miss the commit."

Using a monotonically increasing version number (assigned at commit time) ensures no updates are missed.

---

## Phase 1: Remove Level Dependencies & Simplify Persistence

| Task | Description |
|------|-------------|
| **1.1** | Create `cursor` branch off `main` |
| **1.2** | Remove dependencies from `package.json`: `y-leveldb`, `abstract-level`, `browser-level` |
| **1.3** | Delete `src/client/persistence/sqlite-level.ts` (abstract-level wrapper) |
| **1.4** | Delete `src/client/persistence/indexeddb.ts` (replaced by SQLite) |
| **1.5** | Keep `src/client/persistence/memory.ts` for testing |

---

## Phase 2: Rewrite SQLite Persistence (Direct Y.Doc Storage)

### New SQLite Schema

```sql
-- Full Y.Doc state (compacted)
CREATE TABLE snapshots (
  collection TEXT PRIMARY KEY,
  data BLOB NOT NULL,              -- Y.encodeStateAsUpdate(ydoc)
  state_vector BLOB,               -- Y.encodeStateVector(ydoc) for quick sync
  version INTEGER DEFAULT 0        -- Latest version included in snapshot
);

-- Incremental updates (before compaction)
CREATE TABLE updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL,
  data BLOB NOT NULL,              -- Individual Y.Doc update
  version INTEGER NOT NULL         -- Monotonically increasing
);

-- Key-value store for metadata (cursor, etc.)
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Tasks

| Task | Description |
|------|-------------|
| **2.1** | Rewrite `sqlite.ts` with new schema (no y-leveldb) |
| **2.2** | Implement `loadSnapshot()` - load snapshot + pending updates, apply to Y.Doc |
| **2.3** | Implement `saveUpdate()` - store incremental Y.Doc update |
| **2.4** | Implement `compact()` - `Y.mergeUpdates([snapshot, ...updates])`, replace snapshot, delete updates |
| **2.5** | Store `state_vector` in snapshot for quick recovery sync |
| **2.6** | Keep `SqlJsAdapter` and `OPSqliteAdapter` (already work) |

### Key Yjs APIs Used

```typescript
// Full state as a single blob (for snapshots)
const snapshot = Y.encodeStateAsUpdate(ydoc);  // Uint8Array
Y.applyUpdate(ydoc, snapshot);  // Restore

// Merge multiple updates into one (compaction)
const compacted = Y.mergeUpdates([update1, update2, ...]);

// State vector for sync
const stateVector = Y.encodeStateVector(ydoc);
const diff = Y.encodeStateAsUpdate(ydoc, remoteStateVector);
```

---

## Phase 3: Cursor-Based Sync Protocol (Server Component)

### Updated Component Schema

```typescript
// src/component/schema.ts
documents: defineTable({
  collection: v.string(),
  documentId: v.string(),
  crdtBytes: v.bytes(),
  version: v.number(),        // Monotonically increasing (auto-incremented)
})
  .index("by_collection_version", ["collection", "version"])  // NEW: cursor queries
  .index("by_collection_document", ["collection", "documentId"])
```

### Version Increment Pattern

```typescript
// In mutations (insert, update, delete)
const latest = await ctx.db
  .query("documents")
  .withIndex("by_collection_version", q => q.eq("collection", args.collection))
  .order("desc")
  .first();
const nextVersion = (latest?.version ?? 0) + 1;

await ctx.db.insert("documents", {
  collection: args.collection,
  documentId: args.documentId,
  crdtBytes: args.crdtBytes,
  version: nextVersion,
});
```

### Stream Query Pattern

```typescript
// Cursor-based streaming: "give me everything after version X"
const deltas = await ctx.db
  .query("documents")
  .withIndex("by_collection_version", q =>
    q.eq("collection", args.collection).gt("version", args.cursor)
  )
  .take(limit);

// Return new cursor = max version from results
const newCursor = deltas.length > 0 
  ? Math.max(...deltas.map(d => d.version))
  : args.cursor;
```

### Tasks

| Task | Description |
|------|-------------|
| **3.1** | Update component schema - add indexes, peer tracking table |
| **3.2** | Update mutations to auto-increment seq: query max seq + 1 |
| **3.3** | Update `stream` query to use `.gt("seq", cursor)` |
| **3.4** | Add `ack` mutation for peer acknowledgment |
| **3.5** | Add `compact` mutation with peer-aware safety |
| **3.6** | Update disparity detection to use seq-based logic |

---

## Phase 4: Peer Tracking & Safe Compaction

### Why Peer Tracking?

The main branch's compaction is **unsafe** - it deletes old deltas based purely on size threshold, which can cause data loss for slow/offline peers that haven't synced yet.

The Loro branch tracks **which sequence number each peer has synced to**, ensuring we only delete deltas that ALL active peers have already received.

### Component Schema with Peer Tracking

```typescript
// src/component/schema.ts
export default defineSchema({
  // Delta log (append-only until compaction)
  documents: defineTable({
    collection: v.string(),
    documentId: v.string(),
    seq: v.number(),           // Monotonically increasing sequence number
    bytes: v.bytes(),          // CRDT update bytes
  })
    .index("by_collection", ["collection"])
    .index("by_document_seq", ["collection", "documentId", "seq"])
    .index("by_seq", ["collection", "seq"]),

  // Compacted snapshots (one per document)
  snapshots: defineTable({
    collection: v.string(),
    documentId: v.string(),
    bytes: v.bytes(),          // Y.encodeStateAsUpdate() result
    stateVector: v.bytes(),    // Y.encodeStateVector() for recovery
    snapshotSeq: v.number(),   // Seq at time of snapshot
    createdAt: v.number(),
  }).index("by_document", ["collection", "documentId"]),

  // Peer tracking for safe compaction
  peers: defineTable({
    collection: v.string(),
    peerId: v.string(),        // Unique client identifier
    lastSyncedSeq: v.number(), // Last seq this peer acknowledged
    lastSeenAt: v.number(),    // Timestamp for activity timeout
  })
    .index("by_collection", ["collection"])
    .index("by_collection_peer", ["collection", "peerId"]),
});
```

### Acknowledgment Flow

After receiving deltas, client acknowledges the highest seq it has processed:

```typescript
// Client calls this after applying deltas
export const ack = mutation({
  args: {
    collection: v.string(),
    peerId: v.string(),
    syncedSeq: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("peers")
      .withIndex("by_collection_peer", q =>
        q.eq("collection", args.collection).eq("peerId", args.peerId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastSyncedSeq: Math.max(existing.lastSyncedSeq, args.syncedSeq),
        lastSeenAt: Date.now(),
      });
    } else {
      await ctx.db.insert("peers", {
        collection: args.collection,
        peerId: args.peerId,
        lastSyncedSeq: args.syncedSeq,
        lastSeenAt: Date.now(),
      });
    }
  },
});
```

### Safe Compaction

Compaction only deletes deltas that **all active peers** have synced:

```typescript
export const compact = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
    bytes: v.bytes(),           // Compacted snapshot from client
    stateVector: v.bytes(),     // State vector for recovery sync
    peerTimeout: v.number(),    // e.g., 5 minutes - peers older are considered inactive
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const peerCutoff = now - args.peerTimeout;

    // Get all deltas for this document
    const deltas = await ctx.db
      .query("documents")
      .withIndex("by_document_seq", q =>
        q.eq("collection", args.collection).eq("documentId", args.documentId)
      )
      .collect();

    // Find active peers (seen within timeout)
    const activePeers = await ctx.db
      .query("peers")
      .withIndex("by_collection", q => q.eq("collection", args.collection))
      .filter(q => q.gt(q.field("lastSeenAt"), peerCutoff))
      .collect();

    // Find the MINIMUM synced seq across all active peers
    // This is the highest seq we can safely delete up to
    const minSyncedSeq = activePeers.length > 0
      ? Math.min(...activePeers.map(p => p.lastSyncedSeq))
      : Infinity;  // No active peers = safe to delete all

    // Store new snapshot
    const existingSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_document", q =>
        q.eq("collection", args.collection).eq("documentId", args.documentId)
      )
      .first();

    if (existingSnapshot) {
      await ctx.db.delete(existingSnapshot._id);
    }

    const snapshotSeq = deltas.length > 0
      ? Math.max(...deltas.map(d => d.seq))
      : 0;

    await ctx.db.insert("snapshots", {
      collection: args.collection,
      documentId: args.documentId,
      bytes: args.bytes,
      stateVector: args.stateVector,
      snapshotSeq,
      createdAt: now,
    });

    // Only delete deltas that ALL active peers have synced
    let removed = 0;
    for (const delta of deltas) {
      if (delta.seq < minSyncedSeq) {
        await ctx.db.delete(delta._id);
        removed++;
      }
    }

    return { success: true, removed, retained: deltas.length - removed };
  },
});
```

### Stream with Compaction Hint

Server tells client when a document needs compaction:

```typescript
export const stream = query({
  args: {
    collection: v.string(),
    cursor: v.number(),
    limit: v.optional(v.number()),
    sizeThreshold: v.optional(v.number()),  // e.g., 5MB
  },
  returns: v.object({
    changes: v.array(v.object({
      documentId: v.string(),
      seq: v.number(),
      bytes: v.bytes(),
      operationType: v.string(),
    })),
    cursor: v.number(),
    hasMore: v.boolean(),
    compact: v.optional(v.string()),  // documentId that needs compaction
  }),
  handler: async (ctx, args) => {
    // ... fetch deltas ...

    // Check if any document exceeds size threshold
    let compact: string | undefined;
    const allDocs = await ctx.db
      .query("documents")
      .withIndex("by_collection", q => q.eq("collection", args.collection))
      .collect();

    const sizeByDocument = new Map<string, number>();
    for (const doc of allDocs) {
      const current = sizeByDocument.get(doc.documentId) ?? 0;
      sizeByDocument.set(doc.documentId, current + doc.bytes.byteLength);
    }

    for (const [docId, size] of sizeByDocument) {
      if (size > (args.sizeThreshold ?? 5_000_000)) {
        compact = docId;
        break;
      }
    }

    return { changes, cursor: newCursor, hasMore, compact };
  },
});
```

### Client-Side Compaction Flow

```typescript
// In collection.ts sync loop
const result = await client.query(api.stream, { collection, cursor });

// Apply changes...

// Acknowledge sync
await client.mutation(api.ack, {
  collection,
  peerId: clientId,
  syncedSeq: result.cursor,
});

// Handle compaction hint
if (result.compact) {
  const snapshot = Y.encodeStateAsUpdate(ydoc);
  const stateVector = Y.encodeStateVector(ydoc);
  
  await client.mutation(api.compact, {
    collection,
    documentId: result.compact,
    bytes: snapshot,
    stateVector,
    peerTimeout: 5 * 60 * 1000,  // 5 minutes
  });
}
```

### Tasks

| Task | Description |
|------|-------------|
| **4.1** | Add `peers` table to component schema |
| **4.2** | Implement `ack` mutation for peer acknowledgment |
| **4.3** | Implement `compact` mutation with peer-aware safety |
| **4.4** | Update `stream` to return `compact` hint when threshold exceeded |
| **4.5** | Add client-side compaction trigger in collection.ts |
| **4.6** | Store `stateVector` in snapshots for recovery sync |

---

## Phase 5: Client Updates

| Task | Description |
|------|-------------|
| **5.1** | Rename `Checkpoint` service to `CursorService` (stores seq number) |
| **5.2** | Update `collection.ts` to use cursor for streaming |
| **5.3** | Add peer acknowledgment after receiving deltas |
| **5.4** | Add compaction trigger when server sends `compact` hint |
| **5.5** | Generate unique `peerId` per client (persisted in SQLite kv) |
| **5.6** | Update types in `src/shared/types.ts` |

### Cursor Service

```typescript
// src/client/services/cursor.ts
export type Cursor = number;  // Just a sequence number

export class CursorService {
  loadCursor(collection: string): Promise<Cursor>;    // Returns 0 if not found
  saveCursor(collection: string, cursor: Cursor): Promise<void>;
  clearCursor(collection: string): Promise<void>;
}
```

### Client Sync Loop

```typescript
// Simplified sync loop in collection.ts
async function syncLoop(collection: string) {
  const cursor = await cursorService.loadCursor(collection);
  const peerId = await getPeerId();  // From kv store, or generate new UUID
  
  // Subscribe to stream
  client.onUpdate(api.stream, { collection, cursor }, async (result) => {
    // Apply changes to Y.Doc
    for (const change of result.changes) {
      Y.applyUpdate(ydoc, new Uint8Array(change.bytes));
    }
    
    // Save new cursor
    await cursorService.saveCursor(collection, result.cursor);
    
    // Acknowledge to server (for safe compaction)
    await client.mutation(api.ack, {
      collection,
      peerId,
      syncedSeq: result.cursor,
    });
    
    // Handle compaction hint
    if (result.compact) {
      await triggerCompaction(collection, result.compact);
    }
  });
}

async function triggerCompaction(collection: string, documentId: string) {
  const snapshot = Y.encodeStateAsUpdate(ydoc);
  const stateVector = Y.encodeStateVector(ydoc);
  
  await client.mutation(api.compact, {
    collection,
    documentId,
    bytes: snapshot,
    stateVector,
    peerTimeout: 5 * 60 * 1000,  // 5 minutes
  });
}
```

---

## Phase 6: Server Builder Updates

| Task | Description |
|------|-------------|
| **6.1** | Update `src/server/storage.ts` - `createStreamQuery` uses seq cursor |
| **6.2** | Add `createAckMutation` for peer acknowledgment |
| **6.3** | Add `createCompactMutation` for safe compaction |
| **6.4** | Update stream response to include `compact` hint |

### Updated Stream Response

```typescript
// Before (timestamp-based)
{
  changes: [...],
  checkpoint: { lastModified: number },
  hasMore: boolean,
}

// After (cursor-based with compaction hint)
{
  changes: [...],
  cursor: number,        // Sequence number
  hasMore: boolean,
  compact?: string,      // documentId that needs compaction
}
```

---

## Phase 7: Cleanup & Exports

| Task | Description |
|------|-------------|
| **7.1** | Update `src/client/persistence/index.ts` - remove indexeddb, export only sqlite + memory |
| **7.2** | Update `src/client/index.ts` exports |
| **7.3** | Update `package.json` - remove level dependencies |
| **7.4** | Update `tsdown.config.ts` if needed |

### Simplified Persistence Exports

```typescript
// src/client/persistence/index.ts
export { sqlitePersistence, type SqliteAdapter } from "./sqlite.js";
export { memoryPersistence } from "./memory.js";
export { SqlJsAdapter } from "./adapters/sqljs.js";
export { OPSqliteAdapter } from "./adapters/opsqlite.js";
```

---

## Phase 8: Testing & Examples

| Task | Description |
|------|-------------|
| **8.1** | Update illustrations to use new SQLite-only persistence |
| **8.2** | Verify build works for both browser and React Native targets |
| **8.3** | Test compaction with `Y.mergeUpdates()` |
| **8.4** | Test peer tracking - verify slow peers don't lose data |
| **8.5** | Test disparity recovery - client behind compacted deltas |

---

## Summary of Changes

### Files to Delete

- `src/client/persistence/sqlite-level.ts`
- `src/client/persistence/indexeddb.ts`

### Files to Rewrite

- `src/client/persistence/sqlite.ts` (new schema, direct Y.Doc storage)
- `src/client/persistence/index.ts` (simplified exports)
- `src/client/services/checkpoint.ts` → rename to `cursor.ts`
- `src/component/schema.ts` (seq index, peers table, snapshots with stateVector)
- `src/component/public.ts` (seq-based queries, ack, compact mutations)
- `src/server/storage.ts` (seq-based stream, ack, compact)
- `src/client/collection.ts` (cursor sync, peer ack, compaction trigger)

### Files to Keep (minor updates)

- `src/client/persistence/memory.ts`
- `src/client/persistence/adapters/sqljs.ts`
- `src/client/persistence/adapters/opsqlite.ts`
- `src/client/services/reconciliation.ts`

### Dependencies Removed

```json
{
  "y-leveldb": "remove",
  "abstract-level": "remove",
  "browser-level": "remove"
}
```

---

## Sync Protocol Summary

### Three-Part Sync

1. **Cursor-based streaming** (real-time updates)
   - Client: "Give me all changes after seq X"
   - Server: Returns changes + new cursor + optional compaction hint
   - Efficient for ongoing sync

2. **Peer acknowledgment** (safe compaction)
   - Client: "I've synced up to seq Y"
   - Server: Tracks per-peer sync state
   - Enables safe delta deletion

3. **State vector recovery** (cold start / disparity)
   - Client: Sends `Y.encodeStateVector(ydoc)`
   - Server: Computes diff using `Y.diffUpdate()`
   - Efficient for catching up after long offline

### Why This Architecture?

- **Cursor** ensures we never miss server events (solves `_creationTime` ordering problem)
- **Peer tracking** ensures slow/offline peers don't lose data during compaction
- **State Vector** ensures efficient CRDT reconciliation (no duplicate data transfer)

Together they minimize data loss, support offline-first, and optimize bandwidth.

### Compaction Flow

```
1. Stream response includes `compact: documentId` when size threshold exceeded
2. Client receives hint, creates snapshot: Y.encodeStateAsUpdate(ydoc)
3. Client sends compact mutation with snapshot + stateVector
4. Server checks active peers' lastSyncedSeq
5. Server only deletes deltas where seq < min(peer.lastSyncedSeq)
6. Slow peers can still recover via snapshots + remaining deltas
```

---

## Migration Checklist

### Phase 1: Dependencies
- [ ] Create `cursor` branch off `main`
- [ ] Remove Level dependencies from package.json
- [ ] Delete sqlite-level.ts and indexeddb.ts

### Phase 2: Persistence
- [ ] Rewrite sqlite.ts with direct Y.Doc storage
- [ ] Add snapshots, updates, kv tables
- [ ] Implement loadSnapshot, saveUpdate, compact

### Phase 3: Component Schema
- [ ] Add `by_seq` index to documents table
- [ ] Add `peers` table for peer tracking
- [ ] Update snapshots table with stateVector field

### Phase 4: Peer Tracking & Compaction
- [ ] Implement `ack` mutation
- [ ] Implement `compact` mutation with peer-aware safety
- [ ] Update `stream` to return compaction hints
- [ ] Auto-increment seq in mutations

### Phase 5: Client Updates
- [ ] Rename Checkpoint → CursorService
- [ ] Add peer acknowledgment to sync loop
- [ ] Add compaction trigger on server hint
- [ ] Generate and persist peerId

### Phase 6: Server Builder
- [ ] Update createStreamQuery for seq-based cursor
- [ ] Add createAckMutation
- [ ] Add createCompactMutation

### Phase 7: Cleanup
- [ ] Update persistence/index.ts exports
- [ ] Update client/index.ts exports

### Phase 8: Testing
- [ ] Update illustrations
- [ ] Test browser build (sql.js)
- [ ] Test React Native compatibility
- [ ] Test peer tracking (slow peer doesn't lose data)
- [ ] Test disparity recovery (client behind compacted deltas)
