# Compaction Engine

This document describes the compaction strategy for the Replicate sync library.

## Overview

Compaction merges individual Yjs deltas into snapshots and safely deletes old deltas. The key constraint: **never delete data that any active client still needs**.

```
┌─────────────────────────────────────────────────────────────────┐
│                     COMPACTION FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Deltas accumulate    Threshold reached    Safe deletion check  │
│  ─────────────────►   ─────────────────►   ─────────────────►   │
│                                                                 │
│  [δ1][δ2][δ3]...      Merge into           For each session:   │
│                       snapshot             diff(snap, vector)   │
│                                            <= 2 bytes?          │
│                                                                 │
│                                            YES for ALL →        │
│                                            delete deltas        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Design Principles

### 1. Server-Side Only

Compaction runs exclusively on the server (Convex). Clients never compact locally.

| Location         | Compaction | Rationale                                  |
| ---------------- | ---------- | ------------------------------------------ |
| Server           | ✅ Yes     | Single source of truth, has all peer state |
| Client (online)  | ❌ No      | Server handles after sync                  |
| Client (offline) | ❌ No      | Accumulate deltas, sync on reconnect       |

### 2. Peer-Safe Deletion

Deltas are only deleted when **ALL active peers** have received that data.

```typescript
// Pseudo-code for safe deletion check
for (const session of activeSessions) {
  const missing = Y.diffUpdateV2(snapshot, session.vector);
  if (missing.byteLength > 2) {
    // This peer hasn't seen all data in snapshot
    canDelete = false;
    break;
  }
}
```

### 3. Snapshot Preservation

Snapshots are **never deleted**. Any client can always rebuild from the latest snapshot.

## Data Model

### Tables

```typescript
// Deltas: Individual Yjs updates
deltas: {
  collection: string,
  document: string,
  bytes: bytes,        // Yjs update
  seq: number,         // Monotonic sequence number
  client: string,      // Who created this delta
  created: number,     // Timestamp
}

// Snapshots: Merged Yjs state
snapshots: {
  collection: string,
  document: string,
  bytes: bytes,        // Merged Yjs update (full state)
  vector: bytes,       // State vector of snapshot
  seq: number,         // Highest seq included
  created: number,     // When snapshot was created
}

// Sessions: Per-client sync state
sessions: {
  collection: string,
  document: string,
  client: string,
  vector: bytes,       // Client's Yjs state vector
  seq: number,         // Last synced seq number
  connected: boolean,  // Currently connected?
  seen: number,        // Last heartbeat timestamp
}
```

### State Vector

Each client reports their Yjs state vector via the `mark` action (within `presence` mutation). This tells the server exactly what operations the client has seen.

```typescript
// Client reports sync progress
api.presence({
  action: "mark",
  document: docId,
  client: clientId,
  seq: lastSeenSeq,
  vector: Y.encodeStateVector(ydoc),
});
```

## Compaction Algorithm

### Phase 1: Merge Deltas

```typescript
// Gather all deltas and existing snapshot
const deltas = await getDeltas(collection, document);
const snapshot = await getSnapshot(collection, document);

// Merge into unified state
const updates = [];
if (snapshot) updates.push(snapshot.bytes);
updates.push(...deltas.map(d => d.bytes));

const merged = Y.mergeUpdatesV2(updates);
const mergedVector = Y.encodeStateVectorFromUpdateV2(merged);
```

### Phase 2: Identify Active Peers

A peer is "active" if:

- Currently connected (`session.connected === true`), OR
- Disconnected within `timeout` window

```typescript
const now = Date.now();
const activeSessions = sessions.filter(session => {
  if (session.connected) return true;
  if ((now - session.seen) < timeout) return true;
  return false;
});
```

### Phase 3: Check Sync Status

For each active peer, check if they have all data in the snapshot:

```typescript
let canDeleteAll = true;

for (const session of activeSessions) {
  if (!session.vector) {
    // No vector means we can't verify - don't delete
    canDeleteAll = false;
    break;
  }

  const diff = Y.diffUpdateV2(merged, session.vector);
  if (diff.byteLength > 2) {
    // Non-empty diff means peer is missing data
    canDeleteAll = false;
    break;
  }
}
```

### Phase 4: Update Snapshot

Always update/create the snapshot with merged state:

```typescript
await upsertSnapshot({
  collection,
  document,
  bytes: merged,
  vector: mergedVector,
  seq: Math.max(...deltas.map(d => d.seq)),
  created: Date.now(),
});
```

### Phase 5: Delete Deltas (if safe)

```typescript
if (canDeleteAll) {
  for (const delta of deltas) {
    await db.delete(delta._id);
  }
}
```

### Phase 6: Cleanup Stale Sessions

Remove sessions that are disconnected beyond `timeout`:

```typescript
const staleSessions = sessions.filter(s =>
  !s.connected && (now - s.seen) > timeout
);

for (const session of staleSessions) {
  await db.delete(session._id);
}
```

## Implementation

### Dependencies

The replicate component requires `yjs` as a peer dependency:

```json
{
  "peerDependencies": {
    "yjs": "^13.6.0"
  }
}
```

### Schema

Add a `compaction` table for job deduplication and tracking:

```typescript
compaction: defineTable({
  collection: v.string(),
  document: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("running"),
    v.literal("done"),
    v.literal("failed")
  ),
  started: v.number(),
  completed: v.optional(v.number()),
  retries: v.number(),
  error: v.optional(v.string()),
})
  .index("by_document", ["collection", "document", "status"])
  .index("by_status", ["status", "started"])
```

### Schedule Mutation

Schedules compaction with deduplication (one job per document):

```typescript
export const schedule = mutation({
  args: {
    collection: v.string(),
    document: v.string(),
    timeout: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("compaction")
      .withIndex("by_document", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("status", "running")
      )
      .first();

    if (existing) {
      return { id: existing._id, status: "already_running" };
    }

    const pending = await ctx.db
      .query("compaction")
      .withIndex("by_document", q =>
        q.eq("collection", args.collection)
         .eq("document", args.document)
         .eq("status", "pending")
      )
      .first();

    if (pending) {
      return { id: pending._id, status: "already_pending" };
    }

    const id = await ctx.db.insert("compaction", {
      collection: args.collection,
      document: args.document,
      status: "pending",
      started: Date.now(),
      retries: 0,
    });

    await ctx.scheduler.runAfter(0, api.compaction.run, {
      id,
      timeout: args.timeout,
    });

    return { id, status: "scheduled" };
  },
});
```

### Run Mutation

Executes compaction with retry logic:

```typescript
import * as Y from "yjs";

export const run = mutation({
  args: {
    id: v.id("compaction"),
    timeout: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job || job.status === "done") return;

    await ctx.db.patch(args.id, { status: "running" });

    const now = Date.now();
    const timeout = args.timeout ?? 24 * 60 * 60 * 1000;

    try {
      const deltas = await ctx.db
        .query("deltas")
        .withIndex("by_document", q =>
          q.eq("collection", job.collection).eq("document", job.document)
        )
        .collect();

      if (deltas.length === 0) {
        await ctx.db.patch(args.id, { status: "done", completed: now });
        return { removed: 0, retained: 0 };
      }

      const snapshot = await ctx.db
        .query("snapshots")
        .withIndex("by_document", q =>
          q.eq("collection", job.collection).eq("document", job.document)
        )
        .first();

      const updates: Uint8Array[] = [];
      if (snapshot) updates.push(new Uint8Array(snapshot.bytes));
      updates.push(...deltas.map(d => new Uint8Array(d.bytes)));

      const merged = Y.mergeUpdatesV2(updates);
      const vector = Y.encodeStateVectorFromUpdateV2(merged);

      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_document", q =>
          q.eq("collection", job.collection).eq("document", job.document)
        )
        .collect();

      let canDelete = true;
      for (const session of sessions) {
        const isActive = session.connected || (now - session.seen) < timeout;
        if (!isActive) continue;

        if (!session.vector) {
          canDelete = false;
          break;
        }

        const diff = Y.diffUpdateV2(merged, new Uint8Array(session.vector));
        if (diff.byteLength > 2) {
          canDelete = false;
          break;
        }
      }

      if (snapshot) {
        await ctx.db.patch(snapshot._id, {
          bytes: merged.buffer as ArrayBuffer,
          vector: vector.buffer as ArrayBuffer,
          seq: Math.max(...deltas.map(d => d.seq)),
          created: now,
        });
      } else {
        await ctx.db.insert("snapshots", {
          collection: job.collection,
          document: job.document,
          bytes: merged.buffer as ArrayBuffer,
          vector: vector.buffer as ArrayBuffer,
          seq: Math.max(...deltas.map(d => d.seq)),
          created: now,
        });
      }

      let removed = 0;
      if (canDelete) {
        for (const delta of deltas) {
          await ctx.db.delete(delta._id);
          removed++;
        }
      }

      for (const session of sessions) {
        if (session.connected) continue;
        if ((now - session.seen) > timeout) {
          await ctx.db.delete(session._id);
        }
      }

      await ctx.db.patch(args.id, { status: "done", completed: now });
      return { removed, retained: deltas.length - removed };

    } catch (error) {
      const retries = (job.retries ?? 0) + 1;

      if (retries < 3) {
        await ctx.db.patch(args.id, { status: "pending", retries });
        const backoff = Math.pow(2, retries) * 1000;
        await ctx.scheduler.runAfter(backoff, api.compaction.run, args);
      } else {
        await ctx.db.patch(args.id, {
          status: "failed",
          error: String(error),
          completed: now,
        });
      }
      throw error;
    }
  },
});
```

## Configuration

### Options

```typescript
interface CompactionConfig {
  threshold?: number;   // Delta count to trigger compaction (default: 500)
  timeout?: Duration;   // Ignore peers disconnected longer than this (default: "1d")
  retain?: number;      // Keep N recent deltas after compaction (default: 0)
}
```

### Usage

```typescript
import { collection } from "@trestleinc/replicate/server";

export const { material, delta, replicate, presence, session } =
  collection.create<Doc<"tasks">>(components.replicate, "tasks", {
    compaction: {
      threshold: 500,   // Trigger at 500 deltas
      timeout: "30d",   // Wait 30 days for disconnected peers
      retain: 50,       // Keep last 50 deltas as buffer
    },
  });
```

### Common Configurations

| Use Case                     | timeout | threshold | Notes                          |
| ---------------------------- | ------- | --------- | ------------------------------ |
| Real-time collaboration      | `"1d"`  | 500       | Fast cleanup, active users     |
| Mobile app (occasional sync) | `"30d"` | 1000      | Users may be offline for weeks |
| Enterprise (compliance)      | `"90d"` | 2000      | Long retention for audit       |
| Development/Testing          | `"1h"`  | 100       | Fast iteration                 |

## Trigger Conditions

After insert/update/delete, schedule compaction if threshold exceeded:

```typescript
const deltas = await ctx.db.query("deltas")
  .withIndex("by_document", q => q.eq("collection", c).eq("document", d))
  .collect();

if (deltas.length >= (config.threshold ?? 500)) {
  await ctx.runMutation(api.compaction.schedule, {
    collection,
    document,
    timeout: config.timeout,
  });
}
```

The scheduler handles:

- **Deduplication**: Only one job per document runs at a time
- **Retry**: Failed jobs retry with exponential backoff (2s, 4s, 8s)
- **Tracking**: Job status visible in `compaction` table

## Client Recovery

When a client reconnects after being offline, it can always recover:

### Case 1: Client Within timeout

Deltas were retained. Client syncs normally via `delta` query.

### Case 2: Client Beyond timeout

Deltas may have been deleted. Client uses `recovery` query:

```typescript
// Client sends its state vector
const { diff, vector } = await convexClient.query(api.tasks.recovery, {
  document: docId,
  vector: Y.encodeStateVector(ydoc),
});

// Server computes diff from snapshot
// Client applies diff to catch up
if (diff) {
  Y.applyUpdate(ydoc, new Uint8Array(diff));
}
```

The snapshot always contains the full document state, so recovery is always possible.

## Storage Bounds

With proper compaction, storage is bounded:

| Table     | Bound                    | Notes                    |
| --------- | ------------------------ | ------------------------ |
| snapshots | O(documents)             | One per document         |
| deltas    | O(documents × threshold) | Bounded by compaction    |
| sessions  | O(active peers)          | Cleaned up after timeout |

Without compaction, deltas grow unbounded: O(documents × operations).

## Invariants

The compaction engine maintains these invariants:

1. **Recovery Guarantee**: Any client can rebuild from `snapshot + deltas`
2. **No Data Loss**: Deltas only deleted when all active peers have synced
3. **Snapshot Freshness**: Snapshot always contains all compacted deltas
4. **Session Accuracy**: Session vectors accurately reflect client state

## Monitoring

### Job Status

Query the `compaction` table for job status:

```typescript
const jobs = await ctx.db
  .query("compaction")
  .withIndex("by_status", q => q.eq("status", "failed"))
  .collect();
```

| Status    | Meaning                   |
| --------- | ------------------------- |
| `pending` | Scheduled, waiting to run |
| `running` | Currently executing       |
| `done`    | Completed successfully    |
| `failed`  | Failed after 3 retries    |

### Document Health

```typescript
{
  document: string;
  deltas: number;
  snapshot: { size: number; age: number };
  peers: { active: number; stale: number };
  ready: boolean;
}
```

### Warning Signs

- `deltas` growing despite compaction → peers not syncing
- `peers.active` very high → many connected clients
- `ready` always false → investigate stuck peers
- Many `failed` jobs → check error messages in `compaction` table

## Future Considerations

### Partial Compaction

If some peers are behind, we could delete only deltas ALL peers have seen:

```typescript
// Find minimum safe seq across all active peers
const minSafeSeq = Math.min(...activeSessions.map(s => s.seq));

// Delete only deltas below that seq
const safeToDelete = deltas.filter(d => d.seq < minSafeSeq);
```

### Compaction Metrics

Expose metrics for observability:

- `compaction_runs_total` - Total compaction executions
- `compaction_deltas_deleted` - Deltas removed
- `compaction_blocked_by_peers` - Times compaction was blocked
- `compaction_duration_ms` - Time spent compacting

### Multi-Document Batch Compaction

For collections with many documents, batch compaction in a single action:

```typescript
// Compact all documents in collection (admin action)
await convexClient.action(api.tasks.compactAll);
```
