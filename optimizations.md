# Replicate Sync System Design

A complete specification for the session-driven compaction system with snapshot-based recovery.

## Table of Contents

1. [The Snapshot Breakthrough](#1-the-snapshot-breakthrough)
2. [System Overview](#2-system-overview)
3. [Data Model](#3-data-model)
4. [Data Flows](#4-data-flows)
5. [Server API](#5-server-api)
6. [Client Implementation](#6-client-implementation)
7. [Invariants & Guarantees](#7-invariants--guarantees)
8. [Optimizations](#8-optimizations)

---

## 1. The Snapshot Breakthrough

### The Problem Without Snapshots

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    THE PROBLEM (WITHOUT SNAPSHOTS)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Must keep ALL deltas forever:                                           │
│  - Any client might reconnect after arbitrary time                       │
│  - That client needs all deltas since their last sync                    │
│  - We don't know when they'll reconnect                                  │
│  - Storage grows unbounded                                               │
│                                                                          │
│  Must keep ALL sessions forever:                                         │
│  - Need to know what each client has                                     │
│  - Can't delete session = can't know what they need                      │
│  - Sessions accumulate forever                                           │
│  - One stale client blocks compaction for everyone                       │
│                                                                          │
│  Result: System accumulates garbage indefinitely                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Breakthrough: Snapshots Enable Safe Deletion

**Snapshots fundamentally change the game.** They create a checkpoint that enables safe deletion of both sessions AND deltas.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    THE BREAKTHROUGH                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Snapshot = Complete merged state at a point in time                     │
│                                                                          │
│  This enables:                                                           │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 1. DELETE OLD DELTAS                                            │    │
│  │    Snapshot contains all their data (Y.mergeUpdatesV2)          │    │
│  │    Any client can reconstruct state from snapshot               │    │
│  │    Deltas become temporary, not permanent                       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 2. DELETE OLD SESSIONS                                          │    │
│  │    Don't need to track what disconnected clients have           │    │
│  │    When they reconnect, recovery gives them snapshot            │    │
│  │    Sessions become ephemeral "who's online now"                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 3. BOUNDED STORAGE                                              │    │
│  │    Storage = snapshot + recent_deltas + active_sessions         │    │
│  │    Independent of document history length                       │    │
│  │    Independent of total clients ever connected                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Recovery Guarantee

**Recovery is stateless.** We don't need to know anything about a client's history:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    STATELESS RECOVERY                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Client offline for 1 year? No problem:                                  │
│                                                                          │
│  1. Their session was deleted (housekeeping) ─────────────── OK!        │
│  2. Old deltas were deleted (compacted) ──────────────────── OK!        │
│  3. Client reconnects with local state vector                           │
│  4. Server: diff(snapshot + deltas, client_vector)                      │
│  5. Returns exactly what client is missing                              │
│  6. Client applies → full state reconstructed                           │
│                                                                          │
│  ════════════════════════════════════════════════════════════════════   │
│  THE SERVER DOESN'T NEED TO REMEMBER ANYTHING ABOUT THIS CLIENT         │
│  THE CLIENT'S STATE VECTOR TELLS US EXACTLY WHAT THEY NEED              │
│  ════════════════════════════════════════════════════════════════════   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Mathematical Guarantee

```
For any client C with state vector V_c:

  recovery(V_c) = diff(merged_state, V_c)
  
  where merged_state = merge(snapshot, deltas_since_snapshot)

This works because:
  1. snapshot = merge(all_deltas_at_snapshot_time)
  2. merged_state = complete current state
  3. diff(merged_state, V_c) = exactly what C is missing
  4. Applying diff gives C the complete current state

The guarantee holds regardless of:
  ✓ How long C was offline
  ✓ Whether C's session was deleted
  ✓ How many compactions occurred
  ✓ How many other clients connected/disconnected

This is why snapshots enable safe deletion.
```

---

## 2. System Overview

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SYSTEM ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐         ┌─────────────────────────────────────────┐    │
│  │   CLIENT    │         │              SERVER (Convex)             │    │
│  ├─────────────┤         ├─────────────────────────────────────────┤    │
│  │             │         │                                         │    │
│  │  Y.Doc      │◄───────►│  ┌─────────┐  ┌──────────┐  ┌────────┐ │    │
│  │  (subdoc)   │  sync   │  │ deltas  │  │ snapshots│  │sessions│ │    │
│  │             │         │  │ table   │  │  table   │  │ table  │ │    │
│  │  State      │         │  └────┬────┘  └────┬─────┘  └───┬────┘ │    │
│  │  Vector     │────────►│       │            │            │      │    │
│  │             │ heartbeat       │            │            │      │    │
│  │  Cursor     │         │       └────────────┼────────────┘      │    │
│  │  Position   │         │                    │                   │    │
│  │             │         │              ┌─────┴─────┐             │    │
│  └─────────────┘         │              │COMPACTION │             │    │
│                          │              │  LOGIC    │             │    │
│                          │              └───────────┘             │    │
│                          └─────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Three Tables, Three Purposes

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         THREE TABLES                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ DELTAS (documents table)                                        │    │
│  │ Purpose: Recent changes not yet compacted                       │    │
│  │ Lifecycle: Created on edit → Deleted after compaction           │    │
│  │ Retention: Only while active clients still need them            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                          │                                               │
│                          │ compaction merges into                        │
│                          ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ SNAPSHOTS                                                       │    │
│  │ Purpose: Checkpoint of complete document state                  │    │
│  │ Lifecycle: Created/updated during compaction                    │    │
│  │ Retention: One per document, always kept                        │    │
│  │ Key insight: Enables deletion of old deltas AND sessions        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                          │                                               │
│                          │ enables safe deletion of                      │
│                          ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ SESSIONS                                                        │    │
│  │ Purpose: Track active clients for compaction decisions          │    │
│  │ Lifecycle: Created on connect → Marked disconnected → Deleted   │    │
│  │ Retention: While connected, then grace period, then deleted     │    │
│  │ Key insight: Disconnected sessions can be deleted because       │    │
│  │              snapshot guarantees recovery                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Time vs Data Safety

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CORE PRINCIPLE: TIME VS DATA                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  TIME is used for: SESSION LIVENESS                                      │
│  ───────────────────────────────────                                     │
│  "Has this client sent a heartbeat recently?"                           │
│  → No heartbeat for 25s? Mark connected: false                          │
│  → This is SAFE because snapshot enables recovery                       │
│                                                                          │
│  DATA SAFETY is determined by: STATE VECTORS                             │
│  ───────────────────────────────────────────────                         │
│  "What updates does each active client have?"                           │
│  → Only delete deltas that ALL active clients have                      │
│  → Disconnected clients excluded (they'll use snapshot)                 │
│                                                                          │
│  ════════════════════════════════════════════════════════════════════   │
│  ❌ NEVER: "Delete data older than X hours"                             │
│  ✅ ALWAYS: "Delete data that all active sessions have"                 │
│  ════════════════════════════════════════════════════════════════════   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model

### Complete Schema

```typescript
// src/component/schema.ts

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ═══════════════════════════════════════════════════════════════════════
  // DELTAS: Recent changes (temporary, deleted after compaction)
  // ═══════════════════════════════════════════════════════════════════════
  documents: defineTable({
    collection: v.string(),           // Which collection
    documentId: v.string(),           // Which document
    crdtBytes: v.bytes(),             // Yjs update (Y.encodeStateAsUpdateV2)
    seq: v.number(),                  // Global sequence number
  })
    .index("by_collection", ["collection"])
    .index("by_collection_document", ["collection", "documentId"])
    .index("by_seq", ["collection", "seq"]),

  // ═══════════════════════════════════════════════════════════════════════
  // SNAPSHOTS: Checkpoints (one per document, enables safe deletion)
  // ═══════════════════════════════════════════════════════════════════════
  snapshots: defineTable({
    collection: v.string(),           // Which collection
    documentId: v.string(),           // Which document
    snapshotBytes: v.bytes(),         // Merged state (Y.mergeUpdatesV2)
    stateVector: v.bytes(),           // Vector of snapshot (Y.encodeStateVectorFromUpdateV2)
    snapshotSeq: v.number(),          // Seq at time of snapshot
    createdAt: v.number(),            // When snapshot was created
  })
    .index("by_document", ["collection", "documentId"]),

  // ═══════════════════════════════════════════════════════════════════════
  // SESSIONS: Active clients (ephemeral, safe to delete when disconnected)
  // ═══════════════════════════════════════════════════════════════════════
  sessions: defineTable({
    // Identity
    collection: v.string(),           // Which collection
    document: v.string(),             // Which document (per-document sessions!)
    client: v.string(),               // Unique client ID

    // Sync state (for compaction decisions)
    vector: v.optional(v.bytes()),    // What this client has (Y.encodeStateVector)
    connected: v.boolean(),           // Is actively heartbeating?

    // Presence (for collaborative UI)
    seen: v.number(),                 // Last heartbeat timestamp
    cursor: v.optional(v.object({     // Cursor position
      anchor: v.number(),
      head: v.number(),
      field: v.optional(v.string()),
    })),
    user: v.optional(v.string()),     // User ID
    profile: v.optional(v.object({    // Display info
      name: v.optional(v.string()),
      color: v.optional(v.string()),
      avatar: v.optional(v.string()),
    })),

    // Cleanup
    timeoutId: v.optional(v.id("_scheduled_functions")),
  })
    .index("collection", ["collection"])
    .index("document", ["collection", "document"])
    .index("client", ["collection", "document", "client"])
    .index("connected", ["collection", "document", "connected"]),
});
```

### Table Relationships

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    TABLE RELATIONSHIPS                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                      ┌──────────────────┐                                │
│                      │    Collection    │                                │
│                      │   "intervals"    │                                │
│                      └────────┬─────────┘                                │
│                               │                                          │
│              ┌────────────────┼────────────────┐                         │
│              │                │                │                         │
│              ▼                ▼                ▼                         │
│       ┌──────────┐     ┌──────────┐     ┌──────────┐                    │
│       │ Document │     │ Document │     │ Document │                    │
│       │  "doc-1" │     │  "doc-2" │     │  "doc-3" │                    │
│       └────┬─────┘     └────┬─────┘     └────┬─────┘                    │
│            │                │                │                          │
│    ┌───────┼───────┐       ...              ...                         │
│    │       │       │                                                    │
│    ▼       ▼       ▼                                                    │
│ ┌──────┐┌──────┐┌──────┐   Per document:                                │
│ │delta ││delta ││delta │   - 0..N deltas (recent changes)               │
│ │seq:1 ││seq:2 ││seq:3 │   - 0..1 snapshot (checkpoint)                 │
│ └──────┘└──────┘└──────┘   - 0..N sessions (active clients)             │
│    │                                                                    │
│    │  compaction                                                        │
│    ▼                                                                    │
│ ┌──────────────────┐                                                    │
│ │    SNAPSHOT      │                                                    │
│ │ merged(1,2,3)    │                                                    │
│ │ snapshotSeq: 3   │                                                    │
│ └──────────────────┘                                                    │
│                                                                          │
│ ┌──────────────────┐  ┌──────────────────┐                              │
│ │ SESSION client-A │  │ SESSION client-B │                              │
│ │ connected: true  │  │ connected: false │  ← excluded from compaction  │
│ │ vector: [1,2,3]  │  │ vector: [1,2]    │  ← will use snapshot         │
│ └──────────────────┘  └──────────────────┘                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Flows

### Flow 1: Normal Sync (Write Path)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WRITE PATH                                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CLIENT                              SERVER                              │
│  ──────                              ──────                              │
│                                                                          │
│  1. User edits document                                                  │
│     │                                                                    │
│     ▼                                                                    │
│  2. Yjs creates update                                                   │
│     delta = Y.encodeStateAsUpdateV2(subdoc, lastVector)                 │
│     │                                                                    │
│     ▼                                                                    │
│  3. Send to server ─────────────────►  4. Insert delta                  │
│     mutation(update, {                    INSERT INTO documents          │
│       documentId,                         (collection, documentId,       │
│       crdtBytes: delta,                    crdtBytes, seq)               │
│       materializedDoc                                                    │
│     })                                                                   │
│                                                                          │
│                                        5. Update materialized view       │
│                                           (for queries without Yjs)     │
│                                                                          │
│                                        6. Return { seq }                │
│     │                                       │                            │
│     ▼                                       │                            │
│  7. Update lastVector ◄─────────────────────┘                           │
│     lastVector = Y.encodeStateVector(subdoc)                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 2: Normal Sync (Read Path)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    READ PATH (STREAMING)                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CLIENT                              SERVER                              │
│  ──────                              ──────                              │
│                                                                          │
│  1. Subscribe to stream                                                  │
│     onUpdate(stream, { cursor: lastSeq })                               │
│     │                                                                    │
│     │                               2. Query deltas > cursor            │
│     │                                  SELECT * FROM documents          │
│     │                                  WHERE seq > cursor               │
│     │                                  ORDER BY seq                     │
│     │                                                                    │
│     │                               3. Check size threshold             │
│     │                                  IF total_size > threshold        │
│     │                                  THEN include compact hint        │
│     │                                       │                            │
│  4. Receive changes ◄───────────────────────┘                           │
│     { changes, cursor, hasMore, compact? }                              │
│     │                                                                    │
│     ▼                                                                    │
│  5. Apply each delta                                                     │
│     Y.applyUpdateV2(subdoc, delta.crdtBytes)                            │
│     │                                                                    │
│     ▼                                                                    │
│  6. Update cursor                                                        │
│     cursor = response.cursor                                            │
│     │                                                                    │
│     ▼                                                                    │
│  7. If compact hint, trigger compaction                                 │
│     mutation(compact, { documentId })                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 3: Compaction

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPACTION FLOW                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  TRIGGER: Size threshold exceeded (demand-driven, not time-based)       │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ STEP 1: Gather Data                                            │     │
│  │                                                                │     │
│  │   deltas = SELECT * FROM documents                             │     │
│  │            WHERE documentId = ?                                │     │
│  │                                                                │     │
│  │   activeSessions = SELECT * FROM sessions                      │     │
│  │                    WHERE document = ? AND connected = true     │     │
│  │                                                                │     │
│  │   existingSnapshot = SELECT * FROM snapshots                   │     │
│  │                      WHERE documentId = ?                      │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                          │                                               │
│                          ▼                                               │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ STEP 2: Merge State (Server-Side, No Y.Doc Needed)             │     │
│  │                                                                │     │
│  │   // Collect all updates                                       │     │
│  │   updates = []                                                 │     │
│  │   if (existingSnapshot)                                        │     │
│  │     updates.push(existingSnapshot.snapshotBytes)               │     │
│  │   updates.push(...deltas.map(d => d.crdtBytes))                │     │
│  │                                                                │     │
│  │   // Merge into single binary (Yjs magic)                      │     │
│  │   merged = Y.mergeUpdatesV2(updates)                           │     │
│  │   snapshotVector = Y.encodeStateVectorFromUpdateV2(merged)     │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                          │                                               │
│                          ▼                                               │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ STEP 3: Determine Safe Deletions                               │     │
│  │                                                                │     │
│  │   canDeleteAll = true                                          │     │
│  │                                                                │     │
│  │   for each activeSession:                                      │     │
│  │     if (!session.vector)                                       │     │
│  │       canDeleteAll = false  // Be conservative                 │     │
│  │       break                                                    │     │
│  │                                                                │     │
│  │     // What is this session missing?                           │     │
│  │     missing = Y.diffUpdateV2(merged, session.vector)           │     │
│  │                                                                │     │
│  │     if (missing.byteLength > 2)  // Has real content           │     │
│  │       canDeleteAll = false  // Session still catching up       │     │
│  │       break                                                    │     │
│  │                                                                │     │
│  │   // If no active sessions, canDeleteAll = true                │     │
│  │   // Disconnected sessions excluded - they'll use snapshot     │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                          │                                               │
│                          ▼                                               │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ STEP 4: Store Snapshot                                         │     │
│  │                                                                │     │
│  │   UPSERT INTO snapshots                                        │     │
│  │   SET snapshotBytes = merged,                                  │     │
│  │       stateVector = snapshotVector,                            │     │
│  │       snapshotSeq = MAX(deltas.seq),                           │     │
│  │       createdAt = NOW()                                        │     │
│  │   WHERE documentId = ?                                         │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                          │                                               │
│                          ▼                                               │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ STEP 5: Delete Compacted Deltas                                │     │
│  │                                                                │     │
│  │   if (canDeleteAll)                                            │     │
│  │     DELETE FROM documents WHERE documentId = ?                 │     │
│  │     // ALL deltas safe to delete - snapshot has everything     │     │
│  │   else                                                         │     │
│  │     // Keep deltas - some active client still catching up      │     │
│  │     // They'll be deleted on next compaction                   │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 4: Recovery (Reconnecting Client)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    RECOVERY FLOW                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  TRIGGER: Client reconnects after being offline                         │
│                                                                          │
│  CLIENT                              SERVER                              │
│  ──────                              ──────                              │
│                                                                          │
│  1. Encode local state                                                   │
│     clientVector = Y.encodeStateVector(subdoc)                          │
│     │                                                                    │
│     ▼                                                                    │
│  2. Request recovery ───────────────►  3. Gather server state           │
│     query(recovery, {                     snapshot = SELECT snapshotBytes│
│       clientStateVector                              FROM snapshots     │
│     })                                    deltas = SELECT crdtBytes     │
│                                                      FROM documents     │
│                                                      WHERE seq > snap.seq│
│                                           │                              │
│                                           ▼                              │
│                                        4. Merge server state            │
│                                           merged = Y.mergeUpdatesV2([   │
│                                             snapshot.snapshotBytes,     │
│                                             ...deltas.map(d => d.bytes) │
│                                           ])                            │
│                                           │                              │
│                                           ▼                              │
│                                        5. Compute diff                  │
│                                           diff = Y.diffUpdateV2(        │
│                                             merged,                     │
│                                             clientVector                │
│                                           )                             │
│                                           │                              │
│                                           ▼                              │
│  6. Receive diff ◄─────────────────────  Return { diff, serverVector }  │
│     │                                                                    │
│     ▼                                                                    │
│  7. Apply diff                                                           │
│     Y.applyUpdateV2(subdoc, diff)                                       │
│     │                                                                    │
│     ▼                                                                    │
│  8. Resume normal sync                                                   │
│     Subscribe to stream with new cursor                                 │
│                                                                          │
│  ════════════════════════════════════════════════════════════════════   │
│  NOTE: Server doesn't need client's session record!                     │
│  Client's state vector tells us exactly what they need.                 │
│  This is why we can safely delete old sessions.                         │
│  ════════════════════════════════════════════════════════════════════   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 5: Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SESSION LIFECYCLE                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ CONNECT                                                         │    │
│  │                                                                 │    │
│  │   Client calls mark() with initial state                        │    │
│  │   → Session created with connected: true                        │    │
│  │   → Timeout scheduled (heartbeat_interval × 2.5)                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                          │                                               │
│                          ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ HEARTBEAT (every 10s)                                           │    │
│  │                                                                 │    │
│  │   Client calls mark() with:                                     │    │
│  │   - vector: Y.encodeStateVector(subdoc)  ← What client has      │    │
│  │   - cursor: current cursor position      ← For presence UI      │    │
│  │                                                                 │    │
│  │   Server:                                                       │    │
│  │   - Cancels old timeout                                         │    │
│  │   - Schedules new timeout                                       │    │
│  │   - Updates vector, cursor, seen                                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                          │                                               │
│          ┌───────────────┼───────────────┐                              │
│          ▼               ▼               ▼                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                     │
│  │   GRACEFUL   │ │    CRASH     │ │   TIMEOUT    │                     │
│  │    LEAVE     │ │  (no leave)  │ │   CLEANUP    │                     │
│  ├──────────────┤ ├──────────────┤ ├──────────────┤                     │
│  │              │ │              │ │              │                     │
│  │ Client calls │ │ Client dies  │ │ 30 days of   │                     │
│  │ leave()      │ │ unexpectedly │ │ disconnected │                     │
│  │              │ │              │ │              │                     │
│  │ Server:      │ │ Server:      │ │ Server:      │                     │
│  │ connected:   │ │ Timeout      │ │ DELETE       │                     │
│  │   false      │ │ fires →      │ │ session      │                     │
│  │ cursor:      │ │ connected:   │ │ record       │                     │
│  │   cleared    │ │   false      │ │              │                     │
│  │              │ │              │ │ (Safe!       │                     │
│  │ Session      │ │ Session      │ │ Snapshot     │                     │
│  │ preserved    │ │ preserved    │ │ guarantees   │                     │
│  │              │ │              │ │ recovery)    │                     │
│  └──────────────┘ └──────────────┘ └──────────────┘                     │
│          │               │               │                              │
│          └───────────────┼───────────────┘                              │
│                          ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ RECONNECT                                                       │    │
│  │                                                                 │    │
│  │   Client calls recovery() with local state vector               │    │
│  │   → Gets diff of what they're missing                           │    │
│  │   → Applies diff, state fully restored                          │    │
│  │   → Starts new session with mark()                              │    │
│  │                                                                 │    │
│  │   Works regardless of whether old session exists!               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Server API

### Mutations

```typescript
// ═══════════════════════════════════════════════════════════════════════
// mark - Heartbeat / session update
// ═══════════════════════════════════════════════════════════════════════
export const mark = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    client: v.string(),
    vector: v.optional(v.bytes()),    // Y.encodeStateVector(subdoc)
    cursor: v.optional(v.object({
      anchor: v.number(),
      head: v.number(),
      field: v.optional(v.string()),
    })),
    user: v.optional(v.string()),
    profile: v.optional(v.object({
      name: v.optional(v.string()),
      color: v.optional(v.string()),
      avatar: v.optional(v.string()),
    })),
    interval: v.optional(v.number()), // Heartbeat interval for timeout calc
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const interval = args.interval ?? 10000;
    
    const existing = await ctx.db
      .query("sessions")
      .withIndex("client", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("client", args.client)
      )
      .first();
    
    // Cancel existing timeout
    if (existing?.timeoutId) {
      await ctx.scheduler.cancel(existing.timeoutId);
    }
    
    // Schedule disconnect (not delete!) on timeout
    const timeoutId = await ctx.scheduler.runAfter(
      interval * 2.5,
      api.public.disconnect,
      {
        collection: args.collection,
        document: args.document,
        client: args.client,
      }
    );
    
    const updates: Record<string, unknown> = {
      seen: Date.now(),
      timeoutId,
      connected: true,
    };
    
    if (args.vector !== undefined) updates.vector = args.vector;
    if (args.cursor !== undefined) updates.cursor = args.cursor;
    if (args.user !== undefined) updates.user = args.user;
    if (args.profile !== undefined) updates.profile = args.profile;
    
    if (existing) {
      await ctx.db.patch(existing._id, updates);
    } else {
      await ctx.db.insert("sessions", {
        collection: args.collection,
        document: args.document,
        client: args.client,
        connected: true,
        seen: Date.now(),
        vector: args.vector,
        cursor: args.cursor,
        user: args.user,
        profile: args.profile,
        timeoutId,
      });
    }
    
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════
// disconnect - Called by timeout (marks disconnected, doesn't delete)
// ═══════════════════════════════════════════════════════════════════════
export const disconnect = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    client: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("client", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("client", args.client)
      )
      .first();
    
    if (session) {
      await ctx.db.patch(session._id, {
        connected: false,
        cursor: undefined,      // Clear cursor (user not looking)
        timeoutId: undefined,
        // BUT preserve vector for debugging/analytics
      });
    }
    
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════
// leave - Called by client on graceful disconnect
// ═══════════════════════════════════════════════════════════════════════
export const leave = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    client: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("client", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("client", args.client)
      )
      .first();
    
    if (session) {
      if (session.timeoutId) {
        await ctx.scheduler.cancel(session.timeoutId);
      }
      await ctx.db.patch(session._id, {
        connected: false,
        cursor: undefined,
        timeoutId: undefined,
      });
    }
    
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════
// compact - Server-side compaction using state vectors
// ═══════════════════════════════════════════════════════════════════════
export const compact = mutation({
  args: {
    collection: v.string(),
    documentId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    removed: v.number(),
    retained: v.number(),
    snapshotSize: v.number(),
  }),
  handler: async (ctx, args) => {
    // 1. Get all deltas
    const deltas = await ctx.db
      .query("documents")
      .withIndex("by_collection_document", q =>
        q.eq("collection", args.collection)
         .eq("documentId", args.documentId)
      )
      .collect();
    
    if (deltas.length === 0) {
      return { success: true, removed: 0, retained: 0, snapshotSize: 0 };
    }
    
    // 2. Get existing snapshot
    const existingSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_document", q =>
        q.eq("collection", args.collection)
         .eq("documentId", args.documentId)
      )
      .first();
    
    // 3. Merge all into single binary
    const updates: Uint8Array[] = [];
    if (existingSnapshot) {
      updates.push(new Uint8Array(existingSnapshot.snapshotBytes));
    }
    updates.push(...deltas.map(d => new Uint8Array(d.crdtBytes)));
    
    const merged = Y.mergeUpdatesV2(updates);
    const snapshotVector = Y.encodeStateVectorFromUpdateV2(merged);
    
    // 4. Get active sessions
    const activeSessions = await ctx.db
      .query("sessions")
      .withIndex("connected", q =>
        q.eq("collection", args.collection)
         .eq("document", args.documentId)
         .eq("connected", true)
      )
      .collect();
    
    // 5. Check if all active sessions have everything
    let canDeleteAll = true;
    
    for (const session of activeSessions) {
      if (!session.vector) {
        canDeleteAll = false;
        break;
      }
      
      const missing = Y.diffUpdateV2(merged, new Uint8Array(session.vector));
      if (missing.byteLength > 2) {
        canDeleteAll = false;
        break;
      }
    }
    
    // 6. Store/update snapshot
    const snapshotSeq = Math.max(...deltas.map(d => d.seq));
    
    if (existingSnapshot) {
      await ctx.db.patch(existingSnapshot._id, {
        snapshotBytes: merged.buffer as ArrayBuffer,
        stateVector: snapshotVector.buffer as ArrayBuffer,
        snapshotSeq,
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.insert("snapshots", {
        collection: args.collection,
        documentId: args.documentId,
        snapshotBytes: merged.buffer as ArrayBuffer,
        stateVector: snapshotVector.buffer as ArrayBuffer,
        snapshotSeq,
        createdAt: Date.now(),
      });
    }
    
    // 7. Delete deltas if safe
    let removed = 0;
    if (canDeleteAll) {
      for (const delta of deltas) {
        await ctx.db.delete(delta._id);
        removed++;
      }
    }
    
    return {
      success: true,
      removed,
      retained: deltas.length - removed,
      snapshotSize: merged.byteLength,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════
// cleanupSessions - Housekeeping (safe because snapshots guarantee recovery)
// ═══════════════════════════════════════════════════════════════════════
export const cleanupSessions = mutation({
  args: {
    collection: v.string(),
    maxAge: v.optional(v.number()), // Default 30 days
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const maxAge = args.maxAge ?? 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAge;
    
    const oldSessions = await ctx.db
      .query("sessions")
      .withIndex("collection", q => q.eq("collection", args.collection))
      .filter(q =>
        q.and(
          q.eq(q.field("connected"), false),
          q.lt(q.field("seen"), cutoff)
        )
      )
      .collect();
    
    for (const session of oldSessions) {
      await ctx.db.delete(session._id);
    }
    
    return { deleted: oldSessions.length };
  },
});
```

### Queries

```typescript
// ═══════════════════════════════════════════════════════════════════════
// recovery - Stateless recovery for reconnecting clients
// ═══════════════════════════════════════════════════════════════════════
export const recovery = query({
  args: {
    collection: v.string(),
    clientStateVector: v.bytes(),
  },
  returns: v.object({
    diff: v.optional(v.bytes()),
    serverStateVector: v.bytes(),
    cursor: v.number(),
  }),
  handler: async (ctx, args) => {
    // Get snapshot
    const snapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_document", q => q.eq("collection", args.collection))
      .collect();
    
    // Get deltas since snapshots
    const deltas = await ctx.db
      .query("documents")
      .withIndex("by_collection", q => q.eq("collection", args.collection))
      .collect();
    
    if (snapshots.length === 0 && deltas.length === 0) {
      const emptyDoc = new Y.Doc();
      const emptyVector = Y.encodeStateVector(emptyDoc);
      emptyDoc.destroy();
      return {
        serverStateVector: emptyVector.buffer as ArrayBuffer,
        cursor: 0,
      };
    }
    
    // Merge everything
    const updates: Uint8Array[] = [];
    let latestSeq = 0;
    
    for (const snapshot of snapshots) {
      updates.push(new Uint8Array(snapshot.snapshotBytes));
      latestSeq = Math.max(latestSeq, snapshot.snapshotSeq);
    }
    
    for (const delta of deltas) {
      updates.push(new Uint8Array(delta.crdtBytes));
      latestSeq = Math.max(latestSeq, delta.seq);
    }
    
    const merged = Y.mergeUpdatesV2(updates);
    const clientVector = new Uint8Array(args.clientStateVector);
    const diff = Y.diffUpdateV2(merged, clientVector);
    const serverVector = Y.encodeStateVectorFromUpdateV2(merged);
    
    return {
      diff: diff.byteLength > 2 ? (diff.buffer as ArrayBuffer) : undefined,
      serverStateVector: serverVector.buffer as ArrayBuffer,
      cursor: latestSeq,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════
// cursors - Get active cursors for presence UI
// ═══════════════════════════════════════════════════════════════════════
export const cursors = query({
  args: {
    collection: v.string(),
    document: v.string(),
    exclude: v.optional(v.string()), // Exclude self
  },
  returns: v.array(v.object({
    client: v.string(),
    user: v.optional(v.string()),
    profile: v.optional(v.any()),
    cursor: v.object({
      anchor: v.number(),
      head: v.number(),
      field: v.optional(v.string()),
    }),
  })),
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("connected", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("connected", true)
      )
      .collect();
    
    return sessions
      .filter(s => s.client !== args.exclude)
      .filter(s => s.cursor)
      .map(s => ({
        client: s.client,
        user: s.user,
        profile: s.profile,
        cursor: s.cursor!,
      }));
  },
});

// ═══════════════════════════════════════════════════════════════════════
// sessions - Get all sessions for a document
// ═══════════════════════════════════════════════════════════════════════
export const sessions = query({
  args: {
    collection: v.string(),
    document: v.string(),
    connectedOnly: v.optional(v.boolean()),
  },
  returns: v.array(v.object({
    client: v.string(),
    document: v.string(),
    user: v.optional(v.string()),
    profile: v.optional(v.any()),
    connected: v.boolean(),
    seen: v.number(),
  })),
  handler: async (ctx, args) => {
    let query = ctx.db
      .query("sessions")
      .withIndex("document", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
      );
    
    const sessions = await query.collect();
    
    return sessions
      .filter(s => !args.connectedOnly || s.connected)
      .map(s => ({
        client: s.client,
        document: s.document,
        user: s.user,
        profile: s.profile,
        connected: s.connected,
        seen: s.seen,
      }));
  },
});
```

---

## 6. Client Implementation

### CursorTracker with State Vector

```typescript
// src/client/cursor-tracker.ts

export class CursorTracker {
  private subdocManager: SubdocManager;
  // ... other fields
  
  private sendHeartbeat(): void {
    if (this.destroyed) return;
    
    // Get current state vector for this document
    const subdoc = this.subdocManager.get(this.document);
    const vector = subdoc ? Y.encodeStateVector(subdoc) : undefined;
    
    this.convexClient.mutation(this.api.mark, {
      document: this.document,
      client: this.client,
      vector: vector?.buffer,           // NEW: Report what we have
      cursor: this.position ?? undefined,
      user: this.user,
      profile: this.profile,
      interval: this.heartbeatInterval,
    }).catch((error) => {
      logger.warn("Heartbeat failed", { error: String(error) });
    });
  }
}
```

### Recovery Flow

```typescript
// src/client/collection.ts

async function performRecovery(): Promise<number> {
  // Get local state vector
  const localVector = Y.encodeStateVector(subdocManager.rootDoc);
  
  // Ask server for diff
  const response = await convexClient.query(api.recovery, {
    clientStateVector: localVector.buffer as ArrayBuffer,
  });
  
  // Apply diff if any
  if (response.diff) {
    Y.applyUpdateV2(subdocManager.rootDoc, new Uint8Array(response.diff));
  }
  
  // Update local state vector reference
  serverStateVectors.set(collection, new Uint8Array(response.serverStateVector));
  
  // Return cursor for resuming stream subscription
  return response.cursor;
}
```

### Compaction Trigger

```typescript
// src/client/collection.ts

function handleStreamResponse(response: StreamResponse) {
  // Apply changes
  for (const change of response.changes) {
    // ... apply to Yjs
  }
  
  // Update cursor
  cursor = response.cursor;
  
  // Trigger compaction if hinted
  if (response.compact) {
    // Server-side compaction - just trigger it
    convexClient.mutation(api.compact, {
      collection,
      documentId: response.compact,
    }).catch(error => {
      logger.warn("Compaction failed", { error: String(error) });
    });
  }
}
```

---

## 7. Invariants & Guarantees

### System Invariants

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SYSTEM INVARIANTS                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  INVARIANT 1: Snapshot Completeness                                      │
│  ─────────────────────────────────────                                   │
│  snapshot.snapshotBytes = merge(all deltas at snapshot time)            │
│  snapshot.snapshotSeq = max(all delta seqs at snapshot time)            │
│  snapshot.stateVector = encodeStateVectorFromUpdate(snapshotBytes)      │
│                                                                          │
│  INVARIANT 2: Safe Delta Deletion                                        │
│  ─────────────────────────────────────                                   │
│  A delta D can be deleted IFF:                                          │
│    - Snapshot exists with snapshotSeq >= D.seq                          │
│    - All connected sessions have vector covering D                       │
│                                                                          │
│  INVARIANT 3: Recovery Correctness                                       │
│  ─────────────────────────────────────                                   │
│  For any client vector V:                                                │
│    diff(merge(snapshot, deltas), V) + client_state = complete_state     │
│                                                                          │
│  INVARIANT 4: Session Safety                                             │
│  ─────────────────────────────────────                                   │
│  A session can be deleted IFF:                                          │
│    - connected = false                                                   │
│    - Snapshot exists (guarantees recovery)                               │
│                                                                          │
│  INVARIANT 5: No Data Loss                                               │
│  ─────────────────────────────────────                                   │
│  Any edit that was successfully written is recoverable by any client    │
│  via: recovery(clientVector) or stream(cursor)                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Storage Bounds

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    STORAGE BOUNDS                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Per Document:                                                           │
│  ─────────────                                                           │
│  snapshots:  O(1) record, size = merged document state                  │
│  deltas:     O(k) records where k = changes since last full compaction  │
│  sessions:   O(n) records where n = currently connected clients         │
│                                                                          │
│  Total Storage:                                                          │
│  ─────────────                                                           │
│  total = Σ(snapshot_size + delta_backlog + session_overhead)            │
│        = Σ(document_state + active_client_lag)                          │
│                                                                          │
│  Key Property:                                                           │
│  ─────────────                                                           │
│  Storage is bounded by CURRENT state, not HISTORICAL activity           │
│  - 1 year of edits with daily compaction ≈ same storage as 1 day        │
│  - 1000 clients ever connected ≈ same as 10 currently connected         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Optimizations

### Optimizations That Fit

| Optimization | Pattern | Why It Fits |
|--------------|---------|-------------|
| **Visibility-based presence** | Clear cursor when tab hidden, keep session alive | State-driven (visibility → cursor) |
| **Cursor throttling** | Debounce rapid cursor updates (50ms) | Event coalescing, same as prose.ts |
| **Server-side merging** | Use `Y.mergeUpdatesV2` in compaction | Already using Yjs primitives |
| **Size monitoring** | Warn when document exceeds thresholds | Data-driven, runs in existing observer |
| **Session cleanup** | Delete disconnected sessions after 30 days | Safe because snapshots guarantee recovery |

### Optimizations To Avoid

| Anti-Pattern | Why It's Wrong |
|--------------|----------------|
| **Time-based compaction** | Time isn't a demand variable of data |
| **Time-based data deletion** | Slow clients might still need old data |
| **Additional compression** | Yjs encoding is already efficient |
| **LRU subdoc cache** | Conflicts with Yjs persistence model |

---

## Summary

### The Core Insight

**Snapshots enable safe deletion of both sessions AND deltas.**

Because:
1. Snapshot = complete merged state
2. Recovery = diff(snapshot + deltas, client_vector)
3. Recovery is stateless (doesn't need session history)
4. Therefore: old sessions and old deltas can be safely deleted

### The Result

| Before Snapshots | After Snapshots |
|------------------|-----------------|
| Unbounded delta growth | Deltas deleted after compaction |
| Unbounded session growth | Sessions deleted after grace period |
| Storage grows forever | Storage bounded by current state |
| One stale client blocks everyone | Disconnected clients excluded from compaction |

### Implementation Priority

1. **Phase 1**: Add `vector` and `connected` to sessions schema
2. **Phase 2**: Client sends vector with heartbeat
3. **Phase 3**: Server-side compaction using vectors
4. **Phase 4**: Session cleanup job
5. **Phase 5**: Quick wins (visibility, throttling)

---

## References

- [Yjs Documentation](https://docs.yjs.dev/)
- [Yjs Internals](https://github.com/yjs/yjs/blob/main/INTERNALS.md)
- [sessions.md](./sessions.md) - Original feature plan
