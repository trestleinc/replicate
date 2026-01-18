# Local-First Architecture (v2)

## Core Principles

1. **Main Table IS the app** - Normal Convex CRUD. Online clients just use this directly.
2. **Deltas Table is an operation log** - Side effect of main table operations. Only used for offline recovery.
3. **Per-document Y.Doc** - Each document is an independent Y.Doc. No subdocs, no collection-level Y.Map.
4. **Yjs for conflict resolution** - Only kicks in during offline → online transition.
5. **Seq resolves delete conflicts** - Higher sequence number wins.
6. **Fake deltas with markers** - Insert and delete operations create synthetic Yjs deltas for the operation log.

---

## Mental Model

```
┌─────────────────────────────────────────────────────────┐
│  Main Table = Your Convex App                           │
│  ─────────────────────────────────────────────          │
│  • Normal Convex CRUD                                   │
│  • Subscribe, query, mutate - standard stuff            │
│  • THE source of truth                                  │
│  • Online clients just use this directly                │
└─────────────────────────────────────────────────────────┘
                           │
                           │ (side effect: log the operation)
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Deltas Table = Operation Log (for recovery only)       │
│  ─────────────────────────────────────────────          │
│  • Record of what happened (insert/update/delete)       │
│  • Yjs deltas + markers                                 │
│  • ONLY used when offline client reconnects             │
│  • Compactable                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Data Model

### Main Table (Your App Data)

Standard Convex table. Nothing special.

```typescript
// convex/schema.ts
tasks: defineTable({
  id: v.string(),           // Document ID
  title: v.string(),        // User fields...
  content: v.any(),         // Prose fields...
  timestamp: v.number(),    // Last modified (for sync comparison)
})
  .index("by_doc_id", ["id"])
  .index("by_timestamp", ["timestamp"])
```

- **Subscribe for real-time updates** - Normal Convex subscription
- **Hard deletes** - Row gone = document gone
- **This IS your app data**

### Deltas Table (Operation Log)

Stored in the replicate component. Append-only log of operations.

```typescript
// Component internal schema
deltas: defineTable({
  collection: v.string(),   // Collection name
  document: v.string(),     // Document ID
  bytes: v.bytes(),         // Yjs delta (real or synthetic)
  seq: v.number(),          // Global sequence number
  client: v.string(),       // Client ID that produced this
  timestamp: v.number(),    // Server timestamp
})
  .index("by_collection_seq", ["collection", "seq"])
  .index("by_document", ["collection", "document", "seq"])
```

- **Append-only** - Compactable after all peers synced
- **For recovery only** - Not read during normal online operation
- **This is HOW we got here** - Operation history

---

## Online Flow (Normal Convex)

When online, it's just normal Convex. No special sync layer in the hot path.

```typescript
// INSERT
collection.insert({ id: '123', title: 'New task' });
// → Main table: insert row
// → Deltas table: log synthetic insert delta (side effect)

// UPDATE
collection.update('123', { title: 'Updated' });
// → Main table: patch row
// → Deltas table: log Yjs delta (side effect)

// DELETE
collection.delete('123');
// → Main table: delete row
// → Deltas table: log synthetic delete delta (side effect)

// READ
const { data } = useLiveQuery(collection);
// → Subscribe to Main table (normal Convex)
```

**The deltas table is a passive log. It doesn't drive the online experience.**

---

## Offline Recovery Flow

When an offline client reconnects, it uses the deltas table to catch up.

```
┌─────────────┐              ┌─────────────────────────────┐
│   Client    │              │          Convex             │
├─────────────┤              ├─────────────────────────────┤
│             │              │                             │
│ 1. Compare  │ ◀──────────▶ │  Main Table                 │
│    local vs │              │  "What exists now?"         │
│    server   │              │                             │
│             │              │                             │
│ 2. Identify │              │                             │
│    out-of-  │ (local)      │                             │
│    sync docs│              │                             │
│             │              │                             │
│ 3. Request  │ ◀─────────── │  Deltas Table               │
│    deltas   │              │  "What changed since seq X?"│
│             │              │                             │
│ 4. Apply    │              │                             │
│    via Yjs  │ (local)      │  (conflict resolution)      │
│             │              │                             │
│ 5. Push     │ ────────────▶│  Main Table + Deltas        │
│    local    │              │  "Here's what I have"       │
│    changes  │              │                             │
│             │              │                             │
│ 6. Online!  │ ◀──SUBSCRIBE─│  Main Table                 │
│             │              │                             │
└─────────────┘              └─────────────────────────────┘
```

---

## Synthetic Deltas (Markers)

Insert and delete don't naturally produce Yjs deltas, so we create synthetic ones with markers.

### Insert Delta

```typescript
function createInsertDelta(docId: string, data: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc();
  const fields = doc.getMap('fields');
  const meta = doc.getMap('_meta');

  // Set all fields
  for (const [key, value] of Object.entries(data)) {
    if (isProseField(key, value)) {
      const fragment = new Y.XmlFragment();
      fields.set(key, fragment);
      fragmentFromJSON(fragment, value);
    } else {
      fields.set(key, value);
    }
  }

  // Mark as insert
  meta.set('_created', true);
  meta.set('_createdAt', Date.now());

  return Y.encodeStateAsUpdate(doc);
}
```

### Delete Delta

```typescript
function createDeleteDelta(docId: string): Uint8Array {
  const doc = new Y.Doc();
  const meta = doc.getMap('_meta');

  // Mark as deleted
  meta.set('_deleted', true);
  meta.set('_deletedAt', Date.now());

  return Y.encodeStateAsUpdate(doc);
}
```

### Update Delta (Real Yjs)

```typescript
function createUpdateDelta(docId: string, changes: Record<string, unknown>): Uint8Array {
  const doc = getOrCreateDoc(docId);
  const fields = doc.getMap('fields');
  const beforeVector = Y.encodeStateVector(doc);

  doc.transact(() => {
    for (const [key, value] of Object.entries(changes)) {
      if (!isProseField(key)) {
        fields.set(key, value);
      }
      // Prose fields are handled separately via prose binding
    }
  });

  return Y.encodeStateAsUpdate(doc, beforeVector);
}
```

### Applying Deltas (Client-Side)

```typescript
function applyDelta(docId: string, bytes: Uint8Array, seq: number) {
  const doc = getOrCreateDoc(docId);
  Y.applyUpdate(doc, bytes);

  // Check for markers
  const meta = doc.getMap('_meta');

  if (meta.get('_deleted') === true) {
    // Delete marker - check seq for conflict resolution
    const localSeq = getLocalSeq(docId);
    if (seq > localSeq) {
      // Delete wins
      localDocs.delete(docId);
      doc.destroy();
    } else {
      // Local changes newer - ignore delete, will re-push
    }
    return;
  }

  if (meta.get('_created') === true) {
    // Insert marker - new document
    const fields = doc.getMap('fields');
    localDocs.set(docId, serializeFields(fields));
  }

  // Regular update - extract fields and update local state
  const fields = doc.getMap('fields');
  localDocs.set(docId, serializeFields(fields));
  updateLocalSeq(docId, seq);
}
```

---

## Conflict Resolution

### Delete vs Update

| Scenario     | Delete Seq | Update Seq | Result                                      |
| ------------ | ---------- | ---------- | ------------------------------------------- |
| Delete newer | 8          | 5          | **Delete wins** - Document removed          |
| Update newer | 5          | 8          | **Update wins** - Document kept/resurrected |
| Tie          | 5          | 5          | **Keep** - Tie goes to existence            |

**Resolution happens client-side when applying deltas:**

```typescript
function handleDeleteConflict(docId: string, deleteSeq: number) {
  const localSeq = getLocalSeq(docId);

  if (deleteSeq > localSeq) {
    // Delete wins - remove locally
    localDocs.delete(docId);
    ydocs.get(docId)?.destroy();
  } else {
    // Local changes are newer - ignore delete
    // Recovery flow will re-push our changes
    markForPush(docId);
  }
}
```

### Content Conflicts

Handled by Yjs automatically when applying updates:

- Concurrent text edits → merged
- Concurrent field updates → last-write-wins (Yjs default) or merged

---

## API Design

### Server API (Convex)

```typescript
// convex/tasks.ts
export const {
  // Main Table (standard Convex operations)
  material,      // Query: Get all documents (SSR/initial load)

  // Mutations (write to Main + log to Deltas)
  insert,        // Mutation: Insert doc + log synthetic delta
  update,        // Mutation: Update doc + log Yjs delta
  remove,        // Mutation: Delete doc + log synthetic delta

  // Recovery (read from Deltas)
  deltas,        // Query: Get deltas since seq

  // Sync Coordination
  mark,          // Mutation: Report client sync position
  compact,       // Mutation: Compact old deltas (peer-aware)

  // Presence (optional)
  sessions,      // Query: Get active sessions
  presence,      // Mutation: Update presence
} = collection.create<Task>(components.replicate, 'tasks');
```

### Server Mutation Flow

```typescript
// INSERT
async function insert(ctx, { document, bytes, material }) {
  // 1. Insert into main table
  await ctx.db.insert(collection, {
    id: document,
    ...material,
    timestamp: Date.now(),
  });

  // 2. Log to deltas table (side effect)
  const seq = await ctx.runMutation(component.mutations.appendDelta, {
    collection,
    document,
    bytes,  // Synthetic insert delta with _created marker
  });

  return { success: true, seq };
}

// UPDATE
async function update(ctx, { document, bytes, material }) {
  // 1. Update main table
  const existing = await ctx.db
    .query(collection)
    .withIndex("by_doc_id", q => q.eq("id", document))
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      ...material,
      timestamp: Date.now(),
    });
  }

  // 2. Log to deltas table (side effect)
  const seq = await ctx.runMutation(component.mutations.appendDelta, {
    collection,
    document,
    bytes,  // Real Yjs delta
  });

  return { success: true, seq };
}

// REMOVE
async function remove(ctx, { document, bytes }) {
  // 1. Delete from main table
  const existing = await ctx.db
    .query(collection)
    .withIndex("by_doc_id", q => q.eq("id", document))
    .first();

  if (existing) {
    await ctx.db.delete(existing._id);
  }

  // 2. Log to deltas table (side effect)
  const seq = await ctx.runMutation(component.mutations.appendDelta, {
    collection,
    document,
    bytes,  // Synthetic delete delta with _deleted marker
  });

  return { success: true, seq };
}
```

### Client API

```typescript
// Collection setup
const tasks = collection.create({
  persistence: () => persistence.sqlite({ name: "tasks", worker: () => new Worker(...) }),
  config: () => ({
    schema: taskSchema,
    convexClient,
    api: api.tasks,
    getKey: (task) => task.id,
  }),
});

// Initialize
await tasks.init();
const collection = tasks.get();

// CRUD (normal usage)
collection.insert({ id: '123', title: 'New task' });
collection.update('123', draft => { draft.title = 'Updated'; });
collection.delete('123');

// Subscribe (reads Main table)
const { data } = useLiveQuery(collection);

// Prose binding (Yjs collaboration)
const binding = await collection.utils.prose(docId, 'content');
```

---

## Recovery Flow (Detailed)

```typescript
async function recover() {
  // 1. Get current server state from Main table
  const serverDocs = await convex.query(api.material);
  const serverDocMap = new Map(serverDocs.map(d => [d.id, d]));

  // 2. Categorize local documents
  const toFetch: string[] = [];   // Server ahead, need deltas
  const toPush: string[] = [];    // We're ahead, push our changes
  const toDelete: string[] = [];  // Server deleted, accept it
  const toCreate: string[] = [];  // We created offline, push to server

  for (const [docId, localDoc] of localDocs) {
    const serverDoc = serverDocMap.get(docId);

    if (!serverDoc) {
      // Document doesn't exist on server
      if (localDoc.pendingCreate) {
        // We created it offline
        toCreate.push(docId);
      } else {
        // Server deleted while we were offline
        // Check deltas for delete seq to resolve conflict
        const deleteInfo = await convex.query(api.deltas, {
          document: docId,
          type: 'delete',
          limit: 1,
        });

        if (deleteInfo && deleteInfo.seq > localDoc.seq) {
          toDelete.push(docId);
        } else {
          // Our changes are newer - resurrect
          toCreate.push(docId);
        }
      }
    } else if (serverDoc.timestamp > localDoc.timestamp) {
      toFetch.push(docId);
    } else if (localDoc.timestamp > serverDoc.timestamp) {
      toPush.push(docId);
    }
    // If equal, we're in sync
  }

  // Check for new docs on server we don't have locally
  for (const serverDoc of serverDocs) {
    if (!localDocs.has(serverDoc.id)) {
      toFetch.push(serverDoc.id);
    }
  }

  // 3. Fetch and apply deltas for out-of-sync docs
  for (const docId of toFetch) {
    const localSeq = getLocalSeq(docId);
    const deltas = await convex.query(api.deltas, {
      document: docId,
      since: localSeq
    });

    for (const delta of deltas) {
      applyDelta(docId, new Uint8Array(delta.bytes), delta.seq);
    }
  }

  // 4. Push local changes to server
  for (const docId of toCreate) {
    const doc = ydocs.get(docId);
    const bytes = Y.encodeStateAsUpdate(doc);
    const material = serializeDoc(doc);

    await convex.mutation(api.insert, {
      document: docId,
      bytes,
      material,
    });
  }

  for (const docId of toPush) {
    const doc = ydocs.get(docId);
    const localVector = getLocalVector(docId);
    const bytes = Y.encodeStateAsUpdate(doc, localVector);
    const material = serializeDoc(doc);

    await convex.mutation(api.update, {
      document: docId,
      bytes,
      material,
    });
  }

  // 5. Apply local deletes (server deleted while we were offline)
  for (const docId of toDelete) {
    localDocs.delete(docId);
    ydocs.get(docId)?.destroy();
    ydocs.delete(docId);
    await persistence.delete(docId);
  }

  // 6. Switch to online mode - subscribe to Main table
  startMainTableSubscription();
}
```

---

## Document Manager (Simplified)

No subdocs. Just a Map of Y.Docs with helpers.

```typescript
interface DocumentManager {
  // Core
  get(id: string): Y.Doc | undefined;
  getOrCreate(id: string): Y.Doc;
  has(id: string): boolean;
  delete(id: string): void;

  // Content access
  getFields(id: string): Y.Map<unknown> | null;
  getFragment(id: string, field: string): Y.XmlFragment | null;

  // Sync helpers
  applyUpdate(id: string, update: Uint8Array): void;
  encodeState(id: string): Uint8Array;
  encodeStateVector(id: string): Uint8Array;
  transactWithDelta(id: string, fn: (fields: Y.Map) => void): Uint8Array;

  // Lifecycle
  documents(): string[];
  destroy(): void;
}

function createDocumentManager(collection: string): DocumentManager {
  const docs = new Map<string, Y.Doc>();

  return {
    get(id) {
      return docs.get(id);
    },

    getOrCreate(id) {
      let doc = docs.get(id);
      if (!doc) {
        doc = new Y.Doc({ guid: `${collection}:${id}` });
        docs.set(id, doc);
      }
      return doc;
    },

    has(id) {
      return docs.has(id);
    },

    delete(id) {
      const doc = docs.get(id);
      if (doc) {
        doc.destroy();
        docs.delete(id);
      }
    },

    getFields(id) {
      const doc = docs.get(id);
      return doc ? doc.getMap('fields') : null;
    },

    getFragment(id, field) {
      const fields = this.getFields(id);
      if (!fields) return null;
      const fragment = fields.get(field);
      return fragment instanceof Y.XmlFragment ? fragment : null;
    },

    applyUpdate(id, update) {
      const doc = this.getOrCreate(id);
      Y.applyUpdate(doc, update);
    },

    encodeState(id) {
      const doc = docs.get(id);
      return doc ? Y.encodeStateAsUpdate(doc) : new Uint8Array();
    },

    encodeStateVector(id) {
      const doc = docs.get(id);
      return doc ? Y.encodeStateVector(doc) : new Uint8Array();
    },

    transactWithDelta(id, fn) {
      const doc = this.getOrCreate(id);
      const fields = doc.getMap('fields');
      const beforeVector = Y.encodeStateVector(doc);

      doc.transact(() => fn(fields));

      return Y.encodeStateAsUpdate(doc, beforeVector);
    },

    documents() {
      return Array.from(docs.keys());
    },

    destroy() {
      for (const doc of docs.values()) {
        doc.destroy();
      }
      docs.clear();
    },
  };
}
```

---

## Effect.ts Actor Model (Batching)

Outbound operations use Effect.ts actors for batching (from main branch pattern):

```typescript
// Actor mailbox pattern for batching outbound deltas
LocalChange
  → Queue.offer
  → debounce (200ms)
  → Queue.takeAll (batch)
  → push to server

// Each document has its own actor
const documentActor = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<LocalChange>();

  while (true) {
    // Wait for first change
    const first = yield* Queue.take(queue);

    // Debounce - collect more changes
    yield* Effect.sleep(Duration.millis(200));

    // Take all pending changes
    const rest = yield* Queue.takeAll(queue);
    const batch = [first, ...rest];

    // Encode combined delta
    const delta = encodeBatchedChanges(batch);

    // Push to server
    yield* pushDelta(delta);
  }
});
```

---

## Prose Fields

Prose fields (XmlFragment) live inside the document's Y.Doc:

```
Y.Doc { guid: 'tasks:doc-123' }
  └── Y.Map('_meta')
  │     └── _created, _deleted, etc.
  └── Y.Map('fields')
        ├── title: "My Task"
        ├── status: "open"
        └── content: Y.XmlFragment  ← Prose field (NOT a subdoc)
```

**Online prose collaboration**: Real-time character edits still flow through delta stream. Main table stores materialized JSON snapshot.

**Awareness/Presence**: Attached to the document's Y.Doc (not a subdoc):

```typescript
// Awareness for collaborative cursors
const awarenessProvider = createAwarenessProvider({
  convexClient,
  api: { presence, sessions },
  document: documentId,
  ydoc: documentManager.get(documentId),  // The document's Y.Doc
  user: { name, color },
});
```

**Distinguishing delta types**:

```typescript
// Synthetic deltas only touch _meta
{ _meta: { _deleted: true } }           // Delete marker
{ _meta: { _created: true }, fields: {...} }  // Insert with initial state

// Real Yjs deltas touch fields (including prose)
{ fields: { content: <XmlFragment changes> } }  // Prose update
{ fields: { title: "new title" } }              // Field update
```

**Client detection**:

```typescript
const meta = doc.getMap('_meta');
if (meta.has('_deleted') || meta.has('_created')) {
  // Synthetic - lifecycle event
} else {
  // Real Yjs delta - content change
}
```

---

## Resolved Design Decisions

| Topic                       | Decision                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| **State vector storage**    | `Y.encodeStateVector(doc)` stored per-doc in persistence             |
| **Pending create tracking** | Local metadata flag: `{ pendingCreate: true }`                       |
| **Compaction strategy**     | Existing `mark` system - compact when all peers past a seq           |
| **Offline queue**           | Y.Doc state IS the queue - pending changes in doc, push on reconnect |
| **Prose serialization**     | Existing `fragmentToJSON` / `fragmentFromJSON` utilities             |

---

## Migration from v1

1. **Rename** `documents` table in component to `deltas`
2. **Remove** subdoc manager, replace with simple document manager
3. **Update** sync flow:
   - Online: Main table subscription (normal Convex)
   - Recovery: Deltas table for catch-up
4. **Implement** synthetic deltas with `_created` / `_deleted` markers
5. **Implement** seq-based conflict resolution for deletes
6. **Keep** Effect.ts actor system for batching outbound operations
