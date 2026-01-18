# Replicate Sync System Design

A complete specification for the session-driven compaction system with snapshot-based recovery.

## Table of Contents

1. [Yjs Fundamentals](#1-yjs-fundamentals)
2. [The Snapshot Breakthrough](#2-the-snapshot-breakthrough)
3. [System Overview](#3-system-overview)
4. [Client-Side Sync Architecture](#4-client-side-sync-architecture)
5. [Data Model](#5-data-model)
6. [Session Identity](#6-session-identity)
7. [Data Flows](#7-data-flows)
8. [Server API](#8-server-api)
9. [Invariants & Guarantees](#9-invariants--guarantees)

---

## 1. Yjs Fundamentals

Understanding Yjs internals is critical for this system's design.

### ClientID

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Y.Doc.clientID                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  What it is:                                                             │
│  - Unique 53-bit integer per Y.Doc instance                             │
│  - Generated randomly by default                                        │
│  - Identifies WHO created an operation                                  │
│                                                                          │
│  Critical rule from Yjs docs:                                            │
│  ────────────────────────────────────────────────────────────────────   │
│  "It's imperative to ensure that no other Y.Doc instance is currently   │
│   using the same ClientID, as having multiple Y.Doc instances with      │
│   identical ClientIDs can lead to document corruption without a         │
│   recovery mechanism."                                                  │
│  ────────────────────────────────────────────────────────────────────   │
│                                                                          │
│  Can be persisted IF:                                                    │
│  - All instances sharing the clientID also share the same Y.Doc state  │
│  - This is true when tabs share localStorage/SQLite                     │
│  - Shared storage = same client = same clientID is CORRECT              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### State Vector

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    STATE VECTOR                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Structure: Map<clientID → clock>                                        │
│                                                                          │
│  Example:                                                                │
│  {                                                                       │
│    client_123: 50,   // Has operations 0-49 from client 123             │
│    client_456: 30,   // Has operations 0-29 from client 456             │
│    client_789: 100,  // Has operations 0-99 from client 789             │
│  }                                                                       │
│                                                                          │
│  What it represents:                                                     │
│  - "I have seen operations 0..clock-1 from each client"                 │
│  - Complete description of what a Y.Doc contains                        │
│  - Used to compute diffs: "what do I have that you don't?"              │
│                                                                          │
│  Key insight:                                                            │
│  - Two Y.Docs with same state vector have the same content              │
│  - State vector comparison tells us if one is "caught up" to another    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Sync Protocol

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    YJS SYNC PROTOCOL                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Client A wants to sync with Server:                                     │
│                                                                          │
│  1. Client sends: stateVector_A                                          │
│     "Here's what I have"                                                │
│                                                                          │
│  2. Server computes: diff = Y.diffUpdate(serverState, stateVector_A)    │
│     "Here's what you're missing"                                        │
│                                                                          │
│  3. Server sends: diff                                                   │
│                                                                          │
│  4. Client applies: Y.applyUpdate(doc, diff)                            │
│     Now client has everything server has                                │
│                                                                          │
│  Key properties of updates:                                              │
│  - Commutative: order doesn't matter                                    │
│  - Associative: grouping doesn't matter                                 │
│  - Idempotent: applying twice is same as once                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Server-Side Operations (No Y.Doc Required)

```typescript
// Yjs provides functions that work directly on binary updates
// No need to instantiate Y.Doc on server

// Merge multiple updates into one
const merged = Y.mergeUpdatesV2([update1, update2, update3]);

// Extract state vector from an update
const vector = Y.encodeStateVectorFromUpdateV2(merged);

// Compute diff between update and state vector
const diff = Y.diffUpdateV2(merged, clientVector);

// diff.byteLength <= 2 means "nothing missing" (empty diff)
```

---

## 2. The Snapshot Breakthrough

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
│  - Need to track what state vector each client has                      │
│  - Can't delete session = can't know what they need                      │
│  - Sessions accumulate forever                                           │
│  - One stale client blocks compaction for everyone                       │
│                                                                          │
│  Result: System accumulates garbage indefinitely                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Breakthrough: Snapshots Enable Safe Deletion

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    THE BREAKTHROUGH                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Snapshot = Merged state with its own state vector                       │
│                                                                          │
│  snapshot.bytes = Y.mergeUpdatesV2(all_deltas)                          │
│  snapshot.vector = Y.encodeStateVectorFromUpdateV2(snapshot.bytes)      │
│                                                                          │
│  This enables:                                                           │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 1. SAFE SESSION DELETION                                        │    │
│  │                                                                 │    │
│  │    If snapshot.vector >= session.vector (for all clientIDs):   │    │
│  │    - Snapshot has all operations the session had               │    │
│  │    - Client can recover from snapshot                          │    │
│  │    - Safe to delete session                                    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 2. SAFE DELTA DELETION                                          │    │
│  │                                                                 │    │
│  │    If all remaining sessions have the operations:              │    │
│  │    - No client needs these deltas anymore                      │    │
│  │    - Safe to delete deltas                                     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 3. BOUNDED STORAGE                                              │    │
│  │                                                                 │    │
│  │    Storage = snapshot + recent_deltas + active_sessions         │    │
│  │    Independent of document history length                       │    │
│  │    Independent of total clients ever connected                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. System Overview

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
│  │  clientID   │  sync   │  │documents│  │ snapshots│  │sessions│ │    │
│  │             │   WS    │  │ (deltas)│  │          │  │        │ │    │
│  │  State      │         │  └────┬────┘  └────┬─────┘  └───┬────┘ │    │
│  │  Vector     │────────►│       │            │            │      │    │
│  │             │ heartbeat       │            │            │      │    │
│  │  SQLite     │         │       └────────────┼────────────┘      │    │
│  │  (persist)  │         │                    │                   │    │
│  │             │         │              ┌─────┴─────┐             │    │
│  │  Effect.ts  │         │              │COMPACTION │             │    │
│  │  Actors     │         │              │  LOGIC    │             │    │
│  └─────────────┘         │              └───────────┘             │    │
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
│  │ DOCUMENTS (deltas)                                              │    │
│  │ Purpose: Store individual updates                               │    │
│  │ Content: Yjs binary updates (operations from clients)           │    │
│  │ Lifecycle: Created on edit → Merged into snapshot → Deleted     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                          │                                               │
│                          │ compaction merges into                        │
│                          ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ SNAPSHOTS                                                       │    │
│  │ Purpose: Checkpoint of complete document state                  │    │
│  │ Content: Merged Yjs update + state vector                       │    │
│  │ Lifecycle: Created/updated during compaction, never deleted     │    │
│  │ Key: snapshot.vector enables safe session + delta deletion      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                          │                                               │
│                          │ enables safe deletion of                      │
│                          ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ SESSIONS                                                        │    │
│  │ Purpose: Track what state vector each client has                │    │
│  │ Content: Client's last known state vector + presence info       │    │
│  │ Lifecycle: Created on connect → Deleted when caught up          │    │
│  │ Key: Deleted ONLY when snapshot.vector >= session.vector        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Client-Side Sync Architecture

### Effect.ts Actor Model

The client uses a **per-document actor model** for sync, built with Effect.ts primitives:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ACTOR-BASED SYNC                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ DocumentActor (one per prose field)                             │    │
│  │                                                                 │    │
│  │   Mailbox: Queue.unbounded<DocumentMessage>                     │    │
│  │                                                                 │    │
│  │   Messages:                                                     │    │
│  │   - LocalChange: User edited the document                       │    │
│  │   - ExternalUpdate: Server sent an update (already applied)     │    │
│  │   - Shutdown: Graceful cleanup                                  │    │
│  │                                                                 │    │
│  │   State:                                                        │    │
│  │   - vector: Current state vector                                │    │
│  │   - pending: SubscriptionRef<boolean> (UI can subscribe)        │    │
│  │   - retryCount: For exponential backoff                         │    │
│  │                                                                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Message Flow:                                                           │
│  ─────────────                                                           │
│                                                                          │
│  LocalChange → Queue.offer                                               │
│      ↓                                                                   │
│  Wait 2ms (batch accumulation window)                                    │
│      ↓                                                                   │
│  Queue.takeAll (collect all pending messages)                            │
│      ↓                                                                   │
│  If any LocalChange in batch:                                            │
│      → Cancel existing debounce fiber (if any)                           │
│      → Start new debounce timer (300ms)                                  │
│      → After debounce: encode delta, call syncFn()                       │
│      → On success: update vector, set pending=false                      │
│      → On failure: retry with exponential backoff                        │
│                                                                          │
│  ExternalUpdate:                                                         │
│      → Just update stored vector (Yjs already applied)                   │
│      → No sync needed (it's from server)                                 │
│                                                                          │
│  Shutdown:                                                               │
│      → Interrupt debounce fiber                                          │
│      → Signal done via Deferred                                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why Actor Model?

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WHY ACTORS?                                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Problem: Fast user typing + server updates                              │
│  ─────────────────────────────────────────────                           │
│  - User types 10 characters in 100ms                                    │
│  - Each keystroke triggers Y.Doc update                                 │
│  - Meanwhile server sends updates from other users                      │
│  - Need to avoid:                                                       │
│    - Race conditions                                                    │
│    - Duplicate syncs                                                    │
│    - Lost updates                                                       │
│    - Overloading server                                                 │
│                                                                          │
│  Solution: Per-document actors                                           │
│  ──────────────────────────────                                          │
│  - One actor per prose field (document)                                 │
│  - Messages processed sequentially (no races)                           │
│  - Queue.takeAll batches rapid changes                                  │
│  - Debounce prevents server spam                                        │
│  - SubscriptionRef for reactive UI                                      │
│                                                                          │
│  Benefits:                                                               │
│  ─────────                                                               │
│  ✓ No concurrent sync for same document                                 │
│  ✓ Rapid edits batched into single sync                                 │
│  ✓ Server updates don't block local edits                               │
│  ✓ Clean shutdown via Deferred                                          │
│  ✓ Automatic retry with backoff                                         │
│  ✓ UI can show "syncing" state reactively                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### ActorManager

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ActorManager                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Purpose: Manage lifecycle of per-document actors                        │
│                                                                          │
│  State: HashMap<documentId, ManagedActor>                                │
│                                                                          │
│  Operations:                                                             │
│  ───────────                                                             │
│  register(documentId, ydoc, syncFn)                                      │
│      → Create actor if not exists                                        │
│      → Return existing actor if already registered                       │
│                                                                          │
│  get(documentId)                                                         │
│      → Return actor or null                                              │
│                                                                          │
│  onLocalChange(documentId)                                               │
│      → Send LocalChange message to actor                                 │
│                                                                          │
│  onServerUpdate(documentId)                                              │
│      → Send ExternalUpdate message to actor                              │
│                                                                          │
│  unregister(documentId)                                                  │
│      → Shutdown actor, close scope                                       │
│                                                                          │
│  destroy()                                                               │
│      → Shutdown all actors                                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Runtime Modes

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ReplicateRuntime                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Two modes:                                                              │
│                                                                          │
│  1. Per-Collection (default)                                             │
│     ─────────────────────────                                            │
│     - Each collection gets its own runtime                              │
│     - Separate ActorManager per collection                              │
│     - Cleanup when collection is destroyed                              │
│                                                                          │
│  2. Singleton (for shared SQLite)                                        │
│     ─────────────────────────────                                        │
│     - Shared runtime across collections                                 │
│     - Reference counting for cleanup                                    │
│     - Use when persistence is shared (sqlite.once() mode)               │
│                                                                          │
│  Usage:                                                                  │
│                                                                          │
│  // Per-collection (default)                                            │
│  const runtime = yield* createRuntime({ kv });                          │
│                                                                          │
│  // Singleton                                                           │
│  const runtime = yield* createRuntime({ kv, singleton: true });         │
│                                                                          │
│  // Execute effects                                                     │
│  await runWithRuntime(runtime, actorManager.onLocalChange(docId));      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Data Model

### Current Schema

```typescript
// src/component/schema.ts

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ═══════════════════════════════════════════════════════════════════════
  // DOCUMENTS: Individual Yjs updates (deltas)
  // ═══════════════════════════════════════════════════════════════════════
  documents: defineTable({
    collection: v.string(),           // Which collection
    document: v.string(),             // Which document
    bytes: v.bytes(),                 // Yjs update binary
    seq: v.number(),                  // Global sequence number for ordering
  })
    .index("by_collection", ["collection"])
    .index("by_document", ["collection", "document"])
    .index("by_seq", ["collection", "seq"]),

  // ═══════════════════════════════════════════════════════════════════════
  // SNAPSHOTS: Merged state checkpoints
  // ═══════════════════════════════════════════════════════════════════════
  snapshots: defineTable({
    collection: v.string(),           // Which collection
    document: v.string(),             // Which document
    bytes: v.bytes(),                 // Merged Yjs update (Y.mergeUpdatesV2)
    vector: v.bytes(),                // State vector (Y.encodeStateVectorFromUpdateV2)
    seq: v.number(),                  // Highest seq included in snapshot
    created: v.number(),              // Timestamp
  })
    .index("by_document", ["collection", "document"]),

  // ═══════════════════════════════════════════════════════════════════════
  // SESSIONS: Client state tracking for compaction
  // ═══════════════════════════════════════════════════════════════════════
  sessions: defineTable({
    // Identity
    collection: v.string(),           // Which collection
    document: v.string(),             // Which document
    client: v.string(),               // Y.Doc.clientID (persisted)

    // Sync state (for compaction decisions)
    vector: v.optional(v.bytes()),    // Client's state vector
    connected: v.boolean(),           // Currently heartbeating?
    seq: v.number(),                  // Last known seq

    // Liveness
    seen: v.number(),                 // Last heartbeat timestamp

    // Presence (for UI)
    user: v.optional(v.string()),     // User ID for grouping
    profile: v.optional(v.object({
      name: v.optional(v.string()),
      color: v.optional(v.string()),
      avatar: v.optional(v.string()),
    })),
    cursor: v.optional(v.object({
      anchor: v.any(),                // Yjs RelativePosition
      head: v.any(),                  // Yjs RelativePosition
      field: v.optional(v.string()),
    })),

    // Watchdog
    timeout: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_collection", ["collection"])
    .index("by_document", ["collection", "document"])
    .index("by_client", ["collection", "document", "client"])
    .index("by_connected", ["collection", "document", "connected"]),
});
```

---

## 6. Session Identity

### Persisting Y.Doc.clientID

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CLIENT IDENTITY MODEL                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Browser with shared storage (SQLite/IndexedDB):                        │
│  ─────────────────────────────────────────────────                       │
│                                                                          │
│   Tab 1          Tab 2          Tab 3                                   │
│     │              │              │                                     │
│     └──────────────┼──────────────┘                                     │
│                    │                                                     │
│                    ▼                                                     │
│           ┌───────────────┐                                              │
│           │    SQLite     │  ← Shared Y.Doc state                        │
│           │  localStorage │  ← Shared clientID                           │
│           └───────────────┘                                              │
│                    │                                                     │
│                    ▼                                                     │
│              Same client!                                                │
│              Same clientID!                                              │
│              Same session!                                               │
│                                                                          │
│  Why this is correct:                                                    │
│  ────────────────────                                                    │
│  - All tabs share the same Y.Doc state (from shared storage)            │
│  - They ARE the same logical client                                     │
│  - Yjs warning about duplicate clientIDs applies to DIFFERENT Y.Docs   │
│  - Shared storage means same Y.Doc = same clientID is SAFE              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Data Flows

### Flow 1: Write Path (with Actor)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WRITE PATH                                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CLIENT                              SERVER                              │
│                                                                          │
│  1. User edits prose field                                               │
│     │                                                                    │
│     ▼                                                                    │
│  2. Y.Doc fires 'update' event                                          │
│     │                                                                    │
│     ▼                                                                    │
│  3. prose.ts captures update                                             │
│     │                                                                    │
│     ▼                                                                    │
│  4. actorManager.onLocalChange(documentId)                               │
│     │                                                                    │
│     ▼                                                                    │
│  5. Actor receives LocalChange                                           │
│     │                                                                    │
│     ▼                                                                    │
│  6. Debounce (300ms, batching)                                           │
│     │                                                                    │
│     ▼                                                                    │
│  7. Encode delta, call syncFn ────────►  8. Insert into documents table  │
│                                              INSERT INTO documents        │
│                                              (collection, document,       │
│                                               bytes, seq)                │
│                                                                          │
│                                          9. Return { seq }               │
│  10. Update vector, pending=false ◄──────────┘                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 2: Read Path (Server Update)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    READ PATH                                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CLIENT                              SERVER                              │
│                                                                          │
│  1. Subscribe (WebSocket)                                                │
│     onUpdate(stream, { cursor })                                        │
│     │                                                                    │
│     │                               2. Query: SELECT * FROM documents   │
│     │                                  WHERE seq > cursor                │
│     │                                                                    │
│  3. Receive changes ◄────────────────────┘                               │
│     │                                                                    │
│     ▼                                                                    │
│  4. collection.ts applies Y.applyUpdate                                  │
│     │                                                                    │
│     ▼                                                                    │
│  5. ops.upsert/insert/delete to TanStack DB                              │
│     │                                                                    │
│     ▼                                                                    │
│  6. actorManager.onServerUpdate(documentId)                              │
│     │                                                                    │
│     ▼                                                                    │
│  7. Actor receives ExternalUpdate                                        │
│     │                                                                    │
│     ▼                                                                    │
│  8. Update stored vector (bookkeeping only)                              │
│     (Yjs update already applied in step 4)                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 3: Compaction

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPACTION FLOW                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STEP 1: Gather Data                                                     │
│  ───────────────────                                                     │
│    deltas = SELECT * FROM documents WHERE document = ?                  │
│    snapshot = SELECT * FROM snapshots WHERE document = ?                │
│    sessions = SELECT * FROM sessions WHERE document = ?                 │
│                                                                          │
│  STEP 2: Merge Into Snapshot                                             │
│  ───────────────────────────                                             │
│    updates = [snapshot?.bytes, ...deltas.map(d => d.bytes)]             │
│    merged = Y.mergeUpdatesV2(updates.filter(Boolean))                   │
│    vector = Y.encodeStateVectorFromUpdateV2(merged)                     │
│                                                                          │
│    UPSERT snapshots SET bytes=merged, vector=vector, seq=max            │
│                                                                          │
│  STEP 3: Cascading Session Cleanup                                       │
│  ─────────────────────────────────                                       │
│    for each session WHERE connected = false:                            │
│      if !session.vector:                                                │
│        DELETE session  // No vector = full recovery from snapshot       │
│        continue                                                         │
│                                                                          │
│      diff = Y.diffUpdateV2(merged, session.vector)                      │
│      if diff.byteLength <= 2:                                           │
│        DELETE session  // Caught up = can recover from snapshot         │
│                                                                          │
│  STEP 4: Check Delta Deletion Safety                                     │
│  ────────────────────────────────────                                    │
│    canDelete = true                                                     │
│    for each remaining session:                                          │
│      if !session.vector:                                                │
│        canDelete = false; break                                         │
│                                                                          │
│      diff = Y.diffUpdateV2(merged, session.vector)                      │
│      if diff.byteLength > 2:                                            │
│        canDelete = false; break                                         │
│                                                                          │
│  STEP 5: Delete Deltas (if safe)                                         │
│  ────────────────────────────────                                        │
│    if canDelete:                                                        │
│      DELETE FROM documents WHERE document = ?                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Server API

### Mutations

```typescript
// mark - Heartbeat with state vector
export const mark = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    client: v.string(),               // Y.Doc.clientID as string
    vector: v.optional(v.bytes()),    // Y.encodeStateVector(doc)
    seq: v.optional(v.number()),
    cursor: v.optional(v.object({...})),
    user: v.optional(v.string()),
    profile: v.optional(v.object({...})),
    interval: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Upsert session with latest vector
    // Reschedule watchdog
  },
});

// compact - Merge deltas, cleanup sessions and deltas
export const compact = mutation({
  args: { collection, document },
  handler: async (ctx, args) => {
    // 1. Merge into snapshot
    // 2. Delete caught-up disconnected sessions
    // 3. Delete deltas if all remaining sessions have them
  },
});
```

### Queries

```typescript
// recovery - Get diff for reconnecting client
export const recovery = query({
  args: {
    collection: v.string(),
    document: v.string(),
    vector: v.bytes(),
  },
  handler: async (ctx, args) => {
    // Merge snapshot + deltas
    // Return diff against client's vector
  },
});

// sessions - Get active sessions for presence UI
export const sessions = query({
  args: {
    collection: v.string(),
    document: v.string(),
    connected: v.optional(v.boolean()),
    exclude: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Return sessions with presence info
  },
});
```

---

## 9. Invariants & Guarantees

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SYSTEM INVARIANTS                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  INVARIANT 1: Snapshot Completeness                                      │
│  ─────────────────────────────────────                                   │
│  snapshot.bytes contains all operations up to snapshot.seq              │
│  snapshot.vector accurately describes what's in snapshot.bytes          │
│                                                                          │
│  INVARIANT 2: Safe Session Deletion                                      │
│  ─────────────────────────────────────                                   │
│  A session is deleted ONLY when:                                        │
│    connected = false AND                                                │
│    diff(snapshot, session.vector).byteLength <= 2                       │
│  This guarantees client can recover from snapshot.                      │
│                                                                          │
│  INVARIANT 3: Safe Delta Deletion                                        │
│  ─────────────────────────────────────                                   │
│  Deltas are deleted ONLY when ALL remaining sessions have them.         │
│  "Have them" = diff(merged, session.vector).byteLength <= 2             │
│                                                                          │
│  INVARIANT 4: Recovery Always Works                                      │
│  ─────────────────────────────────────                                   │
│  For any client with local Y.Doc:                                       │
│    diff(serverState, clientVector) gives exactly what they need         │
│  This works regardless of whether session exists.                       │
│                                                                          │
│  INVARIANT 5: No Data Loss                                               │
│  ─────────────────────────────────────                                   │
│  Every operation that reached the server is either:                     │
│    - In a delta (not yet compacted)                                     │
│    - In the snapshot (compacted)                                        │
│  Clients can always recover full state.                                 │
│                                                                          │
│  INVARIANT 6: Sequential Message Processing                              │
│  ─────────────────────────────────────────────                           │
│  Each DocumentActor processes messages sequentially.                    │
│  No race conditions for same document.                                  │
│  Queue.takeAll ensures batch consistency.                               │
│                                                                          │
│  ════════════════════════════════════════════════════════════════════   │
│  NEVER delete based on time. ALWAYS delete based on state vectors.      │
│  ════════════════════════════════════════════════════════════════════   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```
