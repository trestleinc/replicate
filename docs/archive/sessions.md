# Sessions & Cursors Feature Plan

## Overview

Add real-time session tracking and cursor positions to Replicate by extending the existing sync infrastructure. This enables collaborative features like "who's online" and live cursor positions in editors.

**Important Discoveries:**

1. Current session tracking is per-collection but should be per-document (compaction bug)
2. Current Y.Doc architecture (one doc per collection) doesn't support per-document cursors properly
3. Need Yjs subdocuments pattern for correct per-document clientID and cursor isolation

This plan addresses all three issues with a comprehensive architectural refactor.

### Philosophy

Local-first is about building better collaboration UX. From [Ink & Switch](https://www.inkandswitch.com/local-first/):

> "Cloud apps such as Google Docs have vastly simplified collaboration... Users have come to expect this kind of seamless real-time collaboration. In local-first apps, our ideal is to support real-time collaboration that is on par with the best cloud apps today, or better."

Since Replicate already handles Y.Doc sync internally, it makes architectural sense for awareness to also sync through this component rather than requiring a separate backend (Hocuspocus, PartyKit, etc.).

### Research Sources

This plan is informed by deep research into production sync engines:

- **[Linear Sync Engine](https://github.com/wzhudev/reverse-linear-sync-engine)** - Reverse engineering endorsed by Linear's CTO
- **[Liveblocks Yjs](https://github.com/liveblocks/liveblocks/tree/main/packages/liveblocks-yjs)** - Awareness integration patterns
- **[Hocuspocus](https://github.com/ueberdosis/hocuspocus)** - Server awareness handling
- **[y-electric](https://github.com/electric-sql/electric/tree/main/packages/y-electric)** - Database-backed Yjs sync
- **[BlockSuite/AFFiNE](https://github.com/toeverything/blocksuite)** - Subdocument architecture

---

## Current State & Problems

### Problem 1: Collection-Level Sessions, Document-Level Compaction

**Current Schema:**

```typescript
peers: defineTable({
  collection: v.string(),
  peerId: v.string(),
  lastSyncedSeq: v.number(),  // Global seq across ALL documents
  lastSeenAt: v.number(),
})
  .index("by_collection", ["collection"])
  .index("by_collection_peer", ["collection", "peerId"]),
```

**Compaction is per-document:**

```typescript
compact({
  collection: v.string(),
  documentId: v.string(),  // <-- Specific document
  snapshotBytes: v.bytes(),
})
```

**But sessions are tracked per-collection.** This causes incorrect compaction behavior:

**Scenario:**

1. Alice opens `interval_123` only, syncs to seq=50
2. Bob opens `interval_456` only, syncs to seq=100
3. Both are tracked in the same collection-level table
4. Compaction for `interval_456` sees Alice (seq=50) as an "active client"
5. Compaction retains deltas ≥50 for `interval_456`, even though Alice will NEVER sync that document
6. **Result:** Unbounded delta growth for documents Alice doesn't care about

**Fix:** Sessions must be **per-document**, not per-collection.

### Problem 2: Single Y.Doc Prevents Per-Document Cursors

**Current Architecture:**

```typescript
// One Y.Doc per collection, all documents share it
const ydoc = new Y.Doc({ guid: collection });
const ymap = ydoc.getMap(collection);
ymap.set('doc_a', {...});  // All docs share same clientID
ymap.set('doc_b', {...});  // Same clientID for all!
```

**Why this breaks cursor tracking:**

- Each Y.Doc has a single `clientID`
- If one Y.Doc contains all documents, all documents share the same `clientID`
- Per-document cursor isolation becomes impossible

**Fix:** Use Yjs **subdocuments pattern** - each document becomes a separate Y.Doc with its own `clientID`.

---

## Key Concepts

### Scope Clarification

| Concern                 | Scope             | Purpose                                                 |
| ----------------------- | ----------------- | ------------------------------------------------------- |
| **Sessions (sync)**     | ALL documents     | Compaction safety (`client`, `seq`, `seen` fields)      |
| **Sessions (identity)** | ALL documents     | Who's online (`user`, `profile` fields)                 |
| **Cursors**             | Prose fields only | Cursor positions in editors (`cursor`, `active` fields) |

A document without prose fields still needs session tracking for compaction, just no cursor tracking.

### Client vs User Identity

| Concept    | Yjs Term                     | Our Term | Description                                    |
| ---------- | ---------------------------- | -------- | ---------------------------------------------- |
| **Client** | `clientID`                   | `client` | Unique per Y.Doc instance (per browser tab)    |
| **User**   | `user.id` in awareness state | `user`   | Authenticated user (can have multiple clients) |

**Same user on 2 devices = 2 clients but 1 user**

### Session States

| State                | Meaning                          | Use Case                               |
| -------------------- | -------------------------------- | -------------------------------------- |
| **Active (cursor)**  | User has cursor in this document | Show cursor, typing indicator          |
| **Connected (sync)** | User has this document open      | Show in "online" list, safe compaction |
| **Disconnected**     | User closed this document        | Can compact their deltas               |

Transitions are instant via `visibilitychange` and `beforeunload` handlers (see Instant Disconnect section).

### Yjs Awareness Protocol

From `y-protocols/awareness.js`:

- **Full state replacement** - Each update contains entire state (not deltas)
- **Schemaless JSON** - Any fields allowed (cursor, user, custom)

```typescript
awareness.setLocalState({
  user: { name: "Alice", color: "#ff0000" },
  cursor: { anchor: 5, head: 10 },
});

// Encode for transmission
const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [clientID]);

// Apply on remote client
awarenessProtocol.applyAwarenessUpdate(remoteAwareness, update, 'server');
```

---

## Y.Doc Architecture: Subdocuments

### Why Subdocuments?

The current architecture uses **one Y.Doc per collection** with a Y.Map containing all documents. This doesn't support per-document awareness because:

1. **Single clientID**: All documents share the same Yjs clientID
2. **Single Awareness**: One Awareness instance for entire collection
3. **No isolation**: Awareness updates for doc_a broadcast to users viewing doc_b

### New Architecture: One Subdocument Per Document

```
Collection (workspace)
├── rootDoc (Y.Doc) ─────────────────────────────────────────────┐
│   └── documents (Y.Map<Y.Doc>)                                 │
│       ├── doc_123 → subdoc (Y.Doc) ─── awareness_123           │
│       │   ├── Y.Map (fields: title, status, etc.)              │
│       │   └── Y.XmlFragment (prose content)                    │
│       ├── doc_456 → subdoc (Y.Doc) ─── awareness_456           │
│       │   ├── Y.Map (fields)                                   │
│       │   └── Y.XmlFragment (prose)                            │
│       └── doc_789 → subdoc (Y.Doc) ─── awareness_789           │
│           └── ...                                              │
└────────────────────────────────────────────────────────────────┘
```

**Benefits:**

- Each document has unique `clientID` (proper Yjs semantics)
- Per-document awareness isolation (only sync within document)
- More efficient (only sync what user is viewing)
- Scales better for workspaces with many documents
- Foundation for per-document permissions

### Lazy Loading

Subdocuments are **lazy-loaded** when user calls `utils.prose(docId, field)`:

```typescript
// Root document structure (always loaded)
const rootDoc = new Y.Doc({ guid: `collection:${collectionName}` });
const documentsMap = rootDoc.getMap<Y.Doc>('documents');

// Subdocuments loaded on demand
function getOrCreateSubdoc(documentId: string): Y.Doc {
  let subdoc = documentsMap.get(documentId);
  if (!subdoc) {
    subdoc = new Y.Doc({ guid: documentId });
    documentsMap.set(documentId, subdoc);
  }
  subdoc.load(); // Yjs lazy loading API
  return subdoc;
}
```

### Awareness Per Subdocument

Each subdocument gets its own Awareness instance:

```typescript
const awarenessMap = new Map<string, Awareness>();

function getAwareness(documentId: string): Awareness {
  let awareness = awarenessMap.get(documentId);
  if (!awareness) {
    const subdoc = getOrCreateSubdoc(documentId);
    awareness = new Awareness(subdoc);
    awarenessMap.set(documentId, awareness);
  }
  return awareness;
}
```

### Sync Architecture with Subdocuments

```
┌─────────────────────────────────────────────────────────────────┐
│                        Convex Backend                           │
├─────────────────────────────────────────────────────────────────┤
│  sessions table (per-document)                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ collection | document | client | seq | seen | user |    │   │
│  │ profile | cursor | active                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  documents table (deltas, per-document)                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ collection | document | seq | bytes                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  snapshots table (compaction)                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ collection | document | bytes | vector | seq | created   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ Convex subscriptions
                              │ (per-document queries)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Client                                    │
├─────────────────────────────────────────────────────────────────┤
│  Collection                                                      │
│  ├── rootDoc (Y.Doc)                                            │
│  │   └── documents (Y.Map<Y.Doc>)                               │
│  │       ├── doc_123 (subdoc) ──┬── Y.Map (fields)              │
│  │       │                      └── Y.XmlFragment (prose)       │
│  │       └── doc_456 (subdoc) ──┬── Y.Map (fields)              │
│  │                              └── Y.XmlFragment (prose)       │
│  │                                                               │
│  ├── cursorMap (only for docs with prose bindings)              │
│  │   └── doc_123 → CursorTracker                                │
│  │                                                               │
│  └── activeBindings                                              │
│       └── doc_123:content → EditorBinding { fragment, cursor }  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Proposed Design

### API Structure

**User-facing export is minimal:**

```typescript
// convex/intervals.ts
import { Replicate } from "@trestleinc/replicate/server";
import { components } from "./_generated/api";

const replicate = Replicate(components.replicate);

export const intervals = replicate<Interval>({ collection: "intervals" });
export const comments = replicate<Comment>({ collection: "comments" });
```

**Generated API shape:**

```typescript
// Public (user may call directly)
api.intervals.stream     // real-time sync subscription
api.intervals.material   // SSR prefetch
api.intervals.insert     // create document
api.intervals.update     // update document
api.intervals.remove     // delete document
api.intervals.sessions   // who's online (NEW)
api.intervals.cursors    // cursor positions (NEW)

// Internal (client library calls these, not user)
api.intervals.internal.recovery  // startup reconciliation
api.intervals.internal.mark      // session tracking + cursor
api.intervals.internal.compact   // delta compaction
api.intervals.internal.leave     // disconnect cleanup (NEW)
```

**Client usage unchanged:**

```typescript
const intervals = collection.create({
  config: () => ({
    api: api.intervals,  // just pass the whole thing
    // ...
  }),
});
```

### Schema Changes

**Breaking change:** All component tables updated with cleaner field names. One-word nouns throughout.

```typescript
// Component schema (src/component/schema.ts)

sessions: defineTable({
  collection: v.string(),
  document: v.string(),       // Which document this client has open
  client: v.string(),         // Unique client identifier (browser tab/device)
  seq: v.number(),            // Their sync position for THIS document
  seen: v.number(),           // Last heartbeat timestamp

  // Identity (optional, set by app)
  user: v.optional(v.string()),              // Authenticated user ID
  profile: v.optional(v.object({             // User display info
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    avatar: v.optional(v.string()),
  })),

  // Cursor (optional, only for prose bindings)
  cursor: v.optional(v.object({
    anchor: v.number(),
    head: v.number(),
    field: v.optional(v.string()),           // Which prose field
  })),
  active: v.optional(v.number()),            // Cursor freshness timestamp
})
  .index("collection", ["collection"])
  .index("document", ["collection", "document"])
  .index("client", ["collection", "document", "client"]),

snapshots: defineTable({
  collection: v.string(),
  document: v.string(),
  bytes: v.bytes(),           // Snapshot data
  vector: v.bytes(),          // State vector
  seq: v.number(),            // Snapshot sequence
  created: v.number(),        // Creation timestamp
}).index("document", ["collection", "document"]),

documents: defineTable({
  collection: v.string(),
  document: v.string(),
  bytes: v.bytes(),           // CRDT delta data
  seq: v.number(),
})
  .index("collection", ["collection"])
  .index("document", ["collection", "document"])
  .index("seq", ["collection", "seq"]),
```

### Field Name Mapping

| Old Name             | New Name   | Rationale                                 |
| -------------------- | ---------- | ----------------------------------------- |
| `peers` (table)      | `sessions` | Table tracks client sessions per document |
| `peerId`             | `client`   | Clearer - it's a client/device ID         |
| `documentId`         | `document` | Shorter, context is clear                 |
| `lastSyncedSeq`      | `seq`      | Their sync position                       |
| `lastSeenAt`         | `seen`     | Last heartbeat                            |
| `userId`             | `user`     | Authenticated user ID                     |
| `userData`           | `profile`  | Display info                              |
| `awareness.user.*`   | ❌ removed | Duplicate of `profile`                    |
| `awareness.cursor.*` | `cursor.*` | Flattened - cursor IS awareness           |
| `awarenessUpdatedAt` | `active`   | Cursor freshness                          |
| `snapshotBytes`      | `bytes`    | Context clear from table                  |
| `stateVector`        | `vector`   | Shorter                                   |
| `createdAt`          | `created`  | Shorter                                   |
| `crdtBytes`          | `bytes`    | Context clear from table                  |

### Separation of Concerns

```
sessions table
├── Sync tracking (required for ALL docs)
│   ├── client   - which client/device
│   ├── seq      - where they've synced to
│   └── seen     - last heartbeat
│
├── Identity (optional, set by app for any doc)
│   ├── user     - authenticated user ID
│   └── profile  - display info {name, color, avatar}
│
└── Cursor (optional, only for prose bindings)
    ├── cursor   - {anchor, head, field}
    └── active   - cursor freshness timestamp
```

### Why JSON for Cursor (Not Binary)?

| Aspect             | Binary (`y-protocols`)         | JSON                        |
| ------------------ | ------------------------------ | --------------------------- |
| **Wire size**      | Slightly smaller               | Slightly larger             |
| **Convex storage** | Needs `v.bytes()`              | Native `v.object()`         |
| **Debugging**      | Opaque binary                  | Human-readable in dashboard |
| **Compatibility**  | Must match y-protocols version | No version coupling         |
| **Parsing**        | Client must decode             | Direct use                  |
| **Client compute** | Encode/decode overhead         | Zero overhead               |

The binary format was designed for **incremental WebSocket updates**. In our Convex model, we store **full cursor state per client** and use reactive queries - JSON is simpler and just as effective.

### Session Record Lifecycle

**Session records are permanent.** They track `seq` (sync position) which is critical for safe compaction.

```
Lifecycle:
┌─────────────────────────────────────────────────────────────────┐
│ 1. CREATED: First sync to a document                           │
│    → { client, document, seq: 0, seen: now }                   │
├─────────────────────────────────────────────────────────────────┤
│ 2. UPDATED: Every sync                                          │
│    → seq = max(current, newSeq)                                 │
│    → seen = now                                                 │
├─────────────────────────────────────────────────────────────────┤
│ 3. CURSOR CLEARED: On disconnect (visibilitychange/beforeunload)│
│    → cursor = undefined (cursor disappears from UI)             │
│    → Record itself remains (sync state preserved)               │
├─────────────────────────────────────────────────────────────────┤
│ 4. DELETED: Only on explicit action                             │
│    → Document deleted → cascade delete sessions for that doc    │
│    → User account deleted → cascade delete their records        │
│    → NEVER deleted based on inactivity                          │
└─────────────────────────────────────────────────────────────────┘
```

**Why no time-based cleanup?**

Deleting session records based on inactivity causes data loss:

1. Alice syncs doc to seq=100, goes offline for 2 weeks
2. If we delete her session record, we lose `seq=100`
3. Bob compacts, deletes deltas < 150
4. Alice returns, needs deltas 100-150, they're gone → **data loss**

**Compaction safety:**

- Compaction checks `seen` timestamp to determine "active" clients
- Only active clients' `seq` affects compaction decisions
- Inactive clients don't block compaction, but their records are preserved
- When inactive client returns → `recovery` sync handles catch-up

### Instant Disconnect (beforeunload + sendBeacon)

**Problem:** When a user closes their browser tab, the WebSocket connection is torn down before a normal mutation can complete.

**Solution:** Use `beforeunload` event with `navigator.sendBeacon` to fire a HTTP request that survives page unload.

#### How It Works

| Event              | Trigger             | Mechanism                 | Purpose                                   |
| ------------------ | ------------------- | ------------------------- | ----------------------------------------- |
| `visibilitychange` | Tab hidden/switched | Normal WebSocket mutation | Cursor disappears when user switches tabs |
| `beforeunload`     | Tab closing         | HTTP via `sendBeacon`     | Cursor disappears instantly on tab close  |

#### Client-Side (Automatic)

The library handles this automatically when user binds to a prose field:

```typescript
// Inside CursorTracker (internal - user never writes this)
class CursorTracker {
  private handleVisibility = () => {
    if (document.hidden) {
      // Tab hidden - WebSocket still works
      this.convexClient.mutation(this.api.leave, {
        document: this.document,
        client: this.client,
      });
    }
  };

  private handleUnload = () => {
    // Tab closing - WebSocket dying, use HTTP
    const path = getFunctionName(this.api.leave);
    navigator.sendBeacon(
      `${this.convexUrl}/api/mutation/${path}?format=json`,
      JSON.stringify({ args: { document: this.document, client: this.client } })
    );
  };

  constructor(config) {
    // Auto-register handlers
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("beforeunload", this.handleUnload);
  }

  destroy() {
    // Cleanup handlers
    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("beforeunload", this.handleUnload);
    // Normal disconnect via WebSocket
    this.convexClient.mutation(this.api.leave, {
      document: this.document,
      client: this.client,
    });
  }
}
```

**User code is unchanged:**

```typescript
const binding = await collection.utils.prose(docId, 'content');
// beforeunload handler registered automatically
// User writes zero disconnect code
```

#### Server-Side (leave mutation)

Convex exposes all public mutations via `/api/mutation/{path}` automatically. The `leave` mutation receives the sendBeacon request:

```typescript
// In builder.ts - createLeaveMutation
return mutationGeneric({
  args: {
    document: v.string(),
    client: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(component.public.leave, {
      collection,
      document: args.document,
      client: args.client,
    });
    return null;
  },
});
```

```typescript
// In component/public.ts
export const leave = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    client: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("sessions")
      .withIndex("client", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("client", args.client)
      )
      .first();

    if (record) {
      // Clear cursor but keep session record for sync tracking
      await ctx.db.patch(record._id, {
        cursor: undefined,
        active: undefined,
      });
    }
  },
});
```

#### Why sendBeacon?

| Approach              | Works on Tab Close | Supports Auth | Complexity |
| --------------------- | ------------------ | ------------- | ---------- |
| Normal mutation       | ❌ WebSocket dies  | ✅            | Low        |
| `sendBeacon`          | ✅ Fire-and-forget | ❌            | Low        |
| `fetch` + `keepalive` | ✅                 | ✅            | Medium     |

We use `sendBeacon` because:

- Cursor clearing doesn't need auth (uses `client` ID already in session record)
- Simplest API for fire-and-forget
- Browser guarantees delivery even after page closes

---

### Offline Client Recovery Flow

When a client returns after being offline:

```
1. Client starts with local Y.Doc state
2. Client calls `recovery` with its state vector
3. Server computes diff: (all snapshots + deltas) - client state
4. Server returns missing bytes
5. Client applies diff, now fully synced
6. Client resumes normal `stream` subscription
7. `mark` updates session record with new seq
```

This works even if deltas were compacted while offline, because:

- Compaction creates a snapshot containing all prior state
- Recovery uses state vectors, not sequential deltas
- The snapshot + any post-compaction deltas = full state

### Migration Strategy

Since this is a breaking schema change:

1. **Option A: Clean slate** - Delete all session records on upgrade (they'll be recreated on first sync via recovery)
2. **Option B: Migration** - Add `document` field, backfill from sync activity

Recommend **Option A** - existing records lack `document` and can't be backfilled accurately. Recovery sync ensures no data loss.

---

## API Changes

### Internal APIs

These live under `api.intervals.internal.*` and are called by the client library, not users.

#### `internal.mark` - Extended (Breaking Change)

Now requires `document` and accepts optional identity/cursor fields.

```typescript
export const mark = mutation({
  args: {
    collection: v.string(),
    document: v.string(),              // NEW: Required
    client: v.string(),
    seq: v.optional(v.number()),       // Optional: only sync loop provides this

    // Identity (optional, for any document)
    user: v.optional(v.string()),
    profile: v.optional(v.object({
      name: v.optional(v.string()),
      color: v.optional(v.string()),
      avatar: v.optional(v.string()),
    })),

    // Cursor (optional, only for prose bindings)
    cursor: v.optional(v.object({
      anchor: v.number(),
      head: v.number(),
      field: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("sessions")
      .withIndex("client", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("client", args.client)
      )
      .first();

    const updates: any = {
      seen: now,
    };

    // Only update seq if provided (sync loop calls)
    if (args.seq !== undefined) {
      updates.seq = existing
        ? Math.max(existing.seq, args.seq)
        : args.seq;
    }

    // Only update these if provided
    if (args.user !== undefined) updates.user = args.user;
    if (args.profile !== undefined) updates.profile = args.profile;
    if (args.cursor !== undefined) {
      updates.cursor = args.cursor;
      updates.active = now;
    }

    if (existing) {
      await ctx.db.patch(existing._id, updates);
    } else {
      await ctx.db.insert("sessions", {
        collection: args.collection,
        document: args.document,
        client: args.client,
        seq: args.seq ?? 0,
        ...updates,
      });
    }
  },
});
```

#### `internal.compact` - Updated to Use Per-Document Sessions

```typescript
export const compact = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    bytes: v.bytes(),          // Snapshot bytes
    vector: v.bytes(),         // State vector
  },
  handler: async (ctx, args) => {
    // Only consider clients for THIS document that have active sessions
    const clients = await ctx.db
      .query("sessions")
      .withIndex("document", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
      )
      .collect();

    const minSeq = clients.length > 0
      ? Math.min(...clients.map(p => p.seq))
      : Infinity;

    // ... rest of compaction logic (unchanged)
  },
});
```

#### `internal.leave` - NEW Mutation

Called by client library when disconnecting or unbinding prose.

```typescript
export const leave = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    client: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("client", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("client", args.client)
      )
      .first();

    if (existing) {
      // Clear cursor but keep the session record for sync tracking
      await ctx.db.patch(existing._id, {
        cursor: undefined,
        active: undefined,
      });
    }
  },
});
```

### Public APIs

These live directly under `api.intervals.*` and users may call them.

#### `remove` - Updated (Cascade Delete)

Now cascades deletion to session records for the removed document.

```typescript
// In remove handler, after deleting the document:
const records = await ctx.db
  .query("sessions")
  .withIndex("document", q =>
    q.eq("collection", collection).eq("document", document)
  )
  .collect();

for (const record of records) {
  await ctx.db.delete(record._id);
}
```

This ensures no orphaned session records remain when a document is deleted.

#### `sessions` - NEW Query

Query who's online for a specific document.

```typescript
export const sessions = query({
  args: {
    collection: v.string(),
    document: v.string(),
    group: v.optional(v.boolean()),       // Aggregate by user
  },
  returns: v.array(v.object({
    client: v.string(),
    document: v.string(),
    user: v.optional(v.string()),
    profile: v.optional(v.any()),
    seen: v.number(),
  })),
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("sessions")
      .withIndex("document", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
      )
      .collect();

    let results = records.map(p => ({
      client: p.client,
      document: p.document,
      user: p.user,
      profile: p.profile,
      seen: p.seen,
    }));

    if (args.group) {
      const byUser = new Map();
      for (const p of results) {
        const key = p.user ?? p.client;
        const existing = byUser.get(key);
        if (!existing || p.seen > existing.seen) {
          byUser.set(key, p);
        }
      }
      results = Array.from(byUser.values());
    }

    return results;
  },
});
```

#### `cursors` - NEW Query

Subscribe to cursor positions for a specific document (prose fields only).

```typescript
export const cursors = query({
  args: {
    collection: v.string(),
    document: v.string(),
    exclude: v.optional(v.string()),  // Exclude this client (self)
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
    // Only return records that have a cursor set
    // Cursors are cleared instantly via leave mutation (visibilitychange/beforeunload)
    const records = await ctx.db
      .query("sessions")
      .withIndex("document", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
      )
      .collect();

    return records
      .filter(p => p.client !== args.exclude)
      .filter(p => p.cursor)
      .map(p => ({
        client: p.client,
        user: p.user,
        profile: p.profile,
        cursor: p.cursor!,
      }));
  },
});
```

---

## Client-Side Changes

### 1. Update `mark` Calls

Current code calls `mark` without document. Need to track which documents the user has open.

**Option A: Mark per-document as deltas arrive**

```typescript
const seenDocuments = new Set<string>();
for (const change of changes) {
  seenDocuments.add(change.document);
}
for (const doc of seenDocuments) {
  await convexClient.mutation(api.mark, {
    client,
    document: doc,
    seq: newCursor,
  });
}
```

**Option B: Track "active document" client-side (Recommended)**

- Only mark documents the user has actually opened via `utils.prose()`
- More efficient, matches user intent

### 2. Cursor Tracking (via `binding.cursor`)

**Internal class** - accessed via prose binding, never imported. Only for prose fields.

```typescript
// Users access cursor tracking through prose binding
const binding = await coll.utils.prose(docId, 'content');
binding.cursor.update({ anchor: 5, head: 10 });
// TypeScript infers types from binding - no imports needed
```

**Interface:**

```typescript
interface CursorPosition {
  anchor: number;
  head: number;
  field?: string;  // Which prose field
}

interface ClientCursor {
  client: string;
  user?: string;
  profile?: { name?: string; color?: string; avatar?: string };
  cursor: CursorPosition;
}

interface CursorTracker {
  /** Get local cursor position */
  get(): CursorPosition | null;

  /** Update local cursor position (syncs to server) */
  update(position: CursorPosition): void;

  /** Get all other clients' cursors (excludes self) */
  others(): Map<string, ClientCursor>;

  /** Subscribe to changes */
  on(event: 'change', cb: () => void): void;

  /** Unsubscribe from changes */
  off(event: 'change', cb: () => void): void;

  /** Cleanup and notify server */
  destroy(): void;
}
```

**Usage:**

```typescript
const binding = await collection.utils.prose(docId, 'content');

// Update cursor position (typically from editor selection change)
binding.cursor.update({ anchor: 5, head: 10 });

// Get local cursor
const me = binding.cursor.get();

// Get all other clients' cursors
const others = binding.cursor.others();

// Subscribe to changes
binding.cursor.on('change', () => {
  const cursors = binding.cursor.others();
  // render cursors...
});

// Cleanup on unmount
binding.cursor.destroy();
```

**Internal implementation (JSON-based, no y-protocols):**

```typescript
// src/client/cursor.ts

export class CursorTracker {
  private position: CursorPosition | null = null;
  private remoteClients: Map<string, ClientCursor> = new Map();
  private convexClient: ConvexClient;
  private api: ConvexCollectionApi;
  private collection: string;
  private document: string;
  private client: string;
  private field: string;
  private unsubscribe?: () => void;
  private listeners: Set<() => void> = new Set();

  constructor(config: {
    convexClient: ConvexClient;
    api: ConvexCollectionApi;
    collection: string;
    document: string;
    client: string;
    field: string;
    user?: string;
    profile?: { name?: string; color?: string; avatar?: string };
  }) {
    this.convexClient = config.convexClient;
    this.api = config.api;
    this.collection = config.collection;
    this.document = config.document;
    this.client = config.client;
    this.field = config.field;

    // Subscribe to server cursors
    this.subscribeToServer();
  }

  /** Get local cursor position */
  get(): CursorPosition | null {
    return this.position;
  }

  /** Update local cursor (syncs to server) */
  update(position: Omit<CursorPosition, 'field'>): void {
    this.position = { ...position, field: this.field };
    this.syncToServer();
  }

  /** Get all other clients' cursors (excludes self) */
  others(): Map<string, ClientCursor> {
    return new Map(this.remoteClients);
  }

  /** Subscribe to changes */
  on(event: 'change', cb: () => void): void {
    if (event === 'change') {
      this.listeners.add(cb);
    }
  }

  /** Unsubscribe from changes */
  off(event: 'change', cb: () => void): void {
    if (event === 'change') {
      this.listeners.delete(cb);
    }
  }

  /** Cleanup */
  destroy(): void {
    this.unsubscribe?.();
    this.listeners.clear();

    // Notify server (clear cursor)
    this.convexClient.mutation(this.api.internal.leave, {
      collection: this.collection,
      document: this.document,
      client: this.client,
    }).catch(() => {});
  }

  // --- Private ---

  private syncToServer = debounce(async () => {
    if (!this.position) return;

    await this.convexClient.mutation(this.api.internal.mark, {
      collection: this.collection,
      document: this.document,
      client: this.client,
      cursor: this.position,  // Plain JSON!
    });
  }, 200);

  private subscribeToServer(): void {
    this.unsubscribe = this.convexClient.onUpdate(
      this.api.cursors,
      {
        collection: this.collection,
        document: this.document,
        exclude: this.client,
      },
      (clients) => {
        // Update remote clients map
        this.remoteClients.clear();
        for (const c of clients) {
          this.remoteClients.set(c.client, c);
        }
        // Notify listeners of remote changes
        this.listeners.forEach(cb => cb());
      }
    );
  }
}
```

**Key simplification:** No `y-protocols` encoding/decoding. Cursor state is plain JSON all the way through:

- Client → `mark({ cursor: {...} })` → Convex stores JSON → `cursors()` returns JSON → Client uses directly

### 3. Update `EditorBinding`

```typescript
// Before
export interface EditorBinding {
  readonly fragment: Y.XmlFragment;
  readonly provider: { readonly awareness: null };
  // ...
}

// After
export interface EditorBinding {
  readonly fragment: Y.XmlFragment;
  readonly cursor: CursorTracker;
  // ...
}
```

### 4. Update `utils.prose()` - Subdocuments + Cursor Tracking

Now handles subdocument lazy loading AND creates cursor tracker:

```typescript
async prose(document: string, field: ProseFields<DataType>): Promise<EditorBinding> {
  // 1. Get or create subdocument (lazy loading)
  const rootDoc = this.getRootDoc();
  const documentsMap = rootDoc.getMap<Y.Doc>('documents');

  let subdoc = documentsMap.get(document);
  if (!subdoc) {
    // Create new subdocument with unique guid
    subdoc = new Y.Doc({ guid: document });
    documentsMap.set(document, subdoc);
  }
  subdoc.load();  // Yjs lazy loading

  // 2. Get the fragment from subdocument
  const fragment = subdoc.getXmlFragment(field);

  // 3. Create per-document cursor tracker (JSON-based)
  const cursor = new CursorTracker({
    convexClient: this.convexClient,
    api: this.api,
    collection: this.collection,
    document,
    client: this.client,
    field,
    user: this.config.user,
    profile: this.config.profile,
  });

  // 4. Track this binding for cleanup
  const bindingKey = `${document}:${field}`;
  this.activeBindings.set(bindingKey, { subdoc, cursor });

  return {
    fragment,
    cursor,
    destroy: () => {
      cursor.destroy();
      this.activeBindings.delete(bindingKey);
      // Note: Don't destroy subdoc - may be used by other bindings
    },
  };
}
```

**Key change:** Each document is now a separate Y.Doc (subdocument), not a map entry in a shared Y.Doc. This enables:

- Unique clientID per document (correct Yjs semantics)
- Per-document cursor isolation
- Lazy loading of document content

---

## Authentication Scenarios

### Scenario 1: Same user, 2 devices, same document

```
Device A (laptop): client="abc", document="interval_123", user="user_alice"
Device B (phone):  client="xyz", document="interval_123", user="user_alice"
```

**`sessions({ document: "interval_123", group: true })`**:

```typescript
[{ user: "user_alice", profile: { name: "Alice" }, online: true }]
// One session entry (grouped by user)
```

**`cursors({ document: "interval_123" })`**:

```typescript
[
  { client: "abc", cursor: { anchor: 10, head: 10 } },  // laptop cursor
  { client: "xyz", cursor: { anchor: 25, head: 30 } },  // phone cursor
]
// Two cursors (both labeled "Alice" via profile)
```

### Scenario 2: Same user, 2 devices, different documents

```
Device A: client="abc", document="interval_123", user="user_alice"
Device B: client="xyz", document="interval_456", user="user_alice"
```

**`sessions({ document: "interval_123" })`**:

```typescript
[{ user: "user_alice", online: true }]
// Only Alice's laptop
```

**`sessions({ document: "interval_456" })`**:

```typescript
[{ user: "user_alice", online: true }]
// Only Alice's phone
```

**Each document has its own session list.**

### Scenario 3: User logs in after being anonymous

```typescript
// Update via mark with user
await mark({
  collection: "intervals",
  document: "doc_1",
  client: "abc",
  seq: currentSeq,
  user: "user_alice",
  profile: { name: "Alice", color: "#ff0000" },
});
```

### Scenario 4: User logs out

```typescript
// Clear user/profile via mark
await mark({
  collection: "intervals",
  document: "doc_1",
  client: "abc",
  seq: currentSeq,
  user: null,     // Clear
  profile: null,  // Clear
});
```

---

## Linear Sync Engine Insights

Research into [Linear's sync engine](https://github.com/wzhudev/reverse-linear-sync-engine) (endorsed by Linear's CTO) revealed patterns applicable to Replicate:

### What We Already Have (Same as Linear)

| Pattern                   | Linear            | Replicate            |
| ------------------------- | ----------------- | -------------------- |
| **Global version number** | `lastSyncId`      | `seq` in deltas      |
| **Delta-based sync**      | Broadcast changes | Stream subscription  |
| **Cursor-based sync**     | Track position    | Client tracks cursor |
| **Recovery sync**         | Full bootstrap    | State vectors        |

### Key Linear Patterns We're Adopting

1. **Per-document isolation** - Linear tracks peers per-model, we'll track per-document
2. **JSON for ephemeral state** - Linear stores awareness-like data as JSON, not binary
3. **Lazy loading** - Linear loads models on-demand, we'll load subdocuments on-demand
4. **Clean separation** - Ephemeral (awareness) vs persistent (deltas) storage

### Key Difference: CRDTs vs OT

Linear uses **total ordering** (OT-like) with last-writer-wins. We use **Yjs CRDTs** which handle conflicts automatically at the character level. This is better for rich text collaboration but requires the subdocuments architecture for proper awareness isolation.

---

## Implementation Phases

### Phase 1: Subdocuments Refactor (Foundation)

- [ ] Change Y.Doc structure to one subdoc per document
- [ ] Update `utils.prose()` to lazy-load subdocuments
- [ ] Ensure subdocuments have unique `guid` (use document ID)
- [ ] Update persistence layer to handle subdocuments
- [ ] Test sync still works with new structure

### Phase 2: Per-Document Session Tracking (Bug Fix)

- [ ] Rename `peers` table to `sessions`
- [ ] Update schema with new field names (`document`, `client`, `seq`, `seen`)
- [ ] Update `mark` to require `document`
- [ ] Update `compact` to query by document only
- [ ] Update client `mark` calls to include `document`
- [ ] **Clean slate migration** - delete all session records
- [ ] Add migration note to CHANGELOG

### Phase 3: Identity & Cursors (JSON-based)

- [ ] Add `user`, `profile`, `cursor`, `active` fields to sessions schema
- [ ] Add `sessions` query (who's online)
- [ ] Add `cursors` query (cursor positions for prose)
- [ ] Add `leave` mutation
- [ ] Create `CursorTracker` class (no y-protocols dependency)
- [ ] Test cursor sync with multiple users

### Phase 4: Client Integration

- [ ] Update `EditorBinding` interface to include `cursor`
- [ ] Update `utils.prose()` to create cursor tracker
- [ ] Handle cleanup on unmount/document change
- [ ] Integrate sessions query

### Phase 5: React Hooks & Examples

- [ ] `useSessions(collection, document)` hook
- [ ] `useCursors(collection, document)` hook
- [ ] Update TanStack Start example with cursors
- [ ] Add cursor rendering to TipTap

### Phase 6: React Native

- [ ] Ensure cursor tracking works without TipTap
- [ ] Plain cursor position tracking for native editors
- [ ] Test on Expo example

---

## Design Decisions

### Why session tracking for ALL docs, but cursors only for prose?

- **Session tracking (sync):** Required for compaction safety on ANY document
- **Cursor tracking:** Only makes sense for prose fields with editor bindings
- Documents without prose still need `seq` tracking to avoid delta growth

### Why subdocuments instead of single Y.Doc?

- **Correct Yjs semantics:** Each Y.Doc has unique clientID
- **Per-document cursor isolation:** Cursors isolated to document being viewed
- **Efficiency:** Only sync/load documents user is viewing
- **Future-proof:** Foundation for per-document permissions, selective offline

### Why JSON cursors instead of y-protocols binary?

- **Human-readable:** Debug in Convex dashboard
- **Less compute:** No encoding/decoding on client
- **No dependency:** Don't need `y-protocols` for cursor state
- **Native Convex:** `v.object()` instead of `v.bytes()`

### Why lazy-load subdocuments?

- **Performance:** Don't load all documents on startup
- **Memory:** Only hold open documents in memory
- **Network:** Fetch data only when needed
- **Natural fit:** `utils.prose(doc, field)` is the access point

### Why single-word field names?

- Matches existing pattern: `stream`, `mark`, `compact`, `insert`, `remove`
- Easier to remember and discover
- Cleaner schema: `seq` vs `lastSyncedSeq`, `client` vs `peerId`

### Why extend `mark` instead of new function?

- `mark` already updates the sessions table
- Reduces API surface area
- Natural extension: "mark my position" now includes cursor position

### Why per-document sessions instead of per-collection?

- **Correctness:** Compaction is per-document, so session tracking must match
- **Efficiency:** Don't retain deltas for documents a client hasn't opened
- **Session accuracy:** Show who's in THIS document, not just the collection

### Why separate `seen` and `active`?

- **`seen`:** Updated on sync heartbeat (for compaction decisions)
- **`active`:** Updated on cursor move (for cursor tracking)
- A user can move their cursor without syncing (reading, not editing)
- Cursor updates shouldn't block compaction

### Why `leave` instead of deleting session?

- Preserves `seq` for safe compaction
- Allows "last seen X ago" feature
- Only clears `cursor` (cursor disappears from UI)
- Session record remains for when they return

### Why clean slate migration?

- Existing records lack `document` and can't be backfilled accurately
- Recovery sync ensures no data loss - clients will catch up
- Simpler than complex migration logic
- One-time cost on upgrade

---

## Summary of Key Parameters

| Parameter                    | Field | Purpose                                |
| ---------------------------- | ----- | -------------------------------------- |
| **Cursor debounce**          | —     | 200ms batch for rapid cursor movements |
| **Max clients per document** | —     | Unlimited (records are small)          |

---

## Open Questions

**Resolved:**

- ~~Y.Doc architecture~~ → Subdocuments (Option B)
- ~~Cursor format~~ → JSON (Liveblocks pattern)
- ~~Migration strategy~~ → Clean slate
- ~~Subdoc loading~~ → Lazy on `utils.prose()`
- ~~Table naming~~ → `sessions` (not `peers` or `presence`)
- ~~Field naming~~ → Single-word nouns (`client`, `seq`, `seen`, `cursor`, etc.)
- ~~Sessions vs Cursor scope~~ → Session tracking for ALL docs, cursors only for prose
- ~~Instant disconnect~~ → `visibilitychange` + `beforeunload` with `sendBeacon`

---

## References

- [Yjs Awareness Protocol](https://github.com/yjs/y-protocols/blob/master/awareness.js)
- [Linear Sync Engine (Reverse Engineering)](https://github.com/wzhudev/reverse-linear-sync-engine) - Endorsed by Linear's CTO
- [Liveblocks Yjs Provider](https://github.com/liveblocks/liveblocks/tree/main/packages/liveblocks-yjs) - JSON awareness pattern
- [y-electric implementation](https://github.com/electric-sql/electric/tree/main/packages/y-electric) - Database-backed Yjs
- [Hocuspocus Server](https://github.com/ueberdosis/hocuspocus) - Awareness handling patterns
- [BlockSuite/AFFiNE](https://github.com/toeverything/blocksuite) - Subdocument architecture
- [@convex-dev/presence](https://github.com/get-convex/presence)
- [Ink & Switch: Local-First Software](https://www.inkandswitch.com/local-first/)
