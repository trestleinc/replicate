# Replicate

**Offline-first sync library using Yjs CRDTs and Convex for real-time data synchronization.**

Replicate provides a dual-storage architecture for building offline-capable applications with automatic conflict resolution. It combines Yjs CRDTs with TanStack DB's reactive state management and Convex's reactive backend for real-time synchronization and efficient querying.


## Architecture

### Data Flow

```mermaid
sequenceDiagram
    participant UI as React Component
    participant Collection as TanStack DB Collection
    participant Yjs as Yjs CRDT
    participant Storage as Local Storage<br/>(SQLite)
    participant Convex as Convex Backend
    participant Table as Main Table

    Note over UI,Storage: Client-side (offline-capable)
    UI->>Collection: insert/update/delete
    Collection->>Yjs: Apply change to Y.Doc
    Yjs->>Storage: Persist locally
    Collection-->>UI: Re-render (optimistic)

    Note over Collection,Convex: Sync layer
    Collection->>Convex: Send CRDT delta
    Convex->>Convex: Append to event log
    Convex->>Table: Update materialized doc

    Note over Convex,UI: Real-time updates
    Table-->>Collection: stream subscription
    Collection-->>UI: Re-render with server state
```

### Dual-Storage Pattern

```mermaid
graph TB
    subgraph Client
        TDB[TanStack DB]
        Yjs[Yjs CRDT]
        Local[(SQLite)]
        TDB <--> Yjs
        Yjs <--> Local
    end

    subgraph Convex
        Component[(Event Log<br/>CRDT Deltas)]
        Main[(Main Table<br/>Materialized Docs)]
        Component --> Main
    end

    Yjs -->|insert/update/remove| Component
    Main -->|stream subscription| TDB
```

**Why dual storage?**
- **Event Log (Component)**: Append-only CRDT deltas for conflict resolution and history
- **Main Table**: Materialized current state for efficient queries and indexes
- Similar to CQRS: event log = write model, main table = read model

## Installation

```bash
# Using bun (recommended)
bun add @trestleinc/replicate

# Using pnpm
pnpm add @trestleinc/replicate

# Using npm (v7+)
npm install @trestleinc/replicate
```

## Quick Start

### Step 1: Install the Convex Component

Add the replicate component to your Convex app configuration:

```typescript
// convex/convex.config.ts
import { defineApp } from 'convex/server';
import replicate from '@trestleinc/replicate/convex.config';

const app = defineApp();
app.use(replicate);

export default app;
```

### Step 2: Define Your Schema

Use the `schema.table()` helper to automatically inject required fields:

```typescript
// convex/schema.ts
import { defineSchema } from 'convex/server';
import { v } from 'convex/values';
import { schema } from '@trestleinc/replicate/server';

export default defineSchema({
  tasks: schema.table(
    {
      // Your application fields only!
      // timestamp is automatically injected by schema.table()
      id: v.string(),
      text: v.string(),
      isCompleted: v.boolean(),
    },
    (t) => t
      .index('by_doc_id', ['id'])      // Required for document lookups
      .index('by_timestamp', ['timestamp']) // Required for incremental sync
  ),
});
```

**What `schema.table()` does:**
- Automatically injects `timestamp: v.number()` (for incremental sync)
- You only define your business logic fields

**Required indexes:**
- `by_doc_id` on `['id']` - Enables fast document lookups during updates
- `by_timestamp` on `['timestamp']` - Enables efficient incremental synchronization

### Step 3: Create Replication Functions

Use `replicate()` to bind your component and create collection functions:

```typescript
// convex/tasks.ts
import { replicate } from '@trestleinc/replicate/server';
import { components } from './_generated/api';
import type { Task } from '../src/useTasks';

const r = replicate(components.replicate);

export const {
  stream,
  material,
  recovery,
  insert,
  update,
  remove,
  mark,     // Peer sync progress tracking
  compact,  // Manual compaction trigger
} = r<Task>({
  collection: 'tasks',
  compaction: {
    sizeThreshold: "5mb",  // Type-safe size: "100kb", "5mb", "1gb"
    peerTimeout: "24h",    // Type-safe duration: "30m", "24h", "7d"
  },
});
```

**What `replicate()` generates:**

- `stream` - Real-time CRDT stream query (cursor-based subscriptions with `seq` numbers)
- `material` - SSR-friendly query (for server-side rendering)
- `recovery` - State vector sync query (for startup reconciliation)
- `insert` - Dual-storage insert mutation (auto-compacts when threshold exceeded)
- `update` - Dual-storage update mutation (auto-compacts when threshold exceeded)
- `remove` - Dual-storage delete mutation (auto-compacts when threshold exceeded)
- `mark` - Report sync progress to server (peer tracking for safe compaction)
- `compact` - Manual compaction trigger (peer-aware, respects active peer sync state)

### Step 4: Create a Custom Hook

Create a hook that wraps TanStack DB with Convex collection options:

```typescript
// src/useTasks.ts
import { createCollection, type Collection } from '@tanstack/react-db';
import { convexCollectionOptions, persistence } from '@trestleinc/replicate/client';
import { api } from '../convex/_generated/api';
import { convexClient } from './router';
import { useMemo } from 'react';
import { z } from 'zod';

// Define your Zod schema (required)
const taskSchema = z.object({
  id: z.string(),
  text: z.string(),
  isCompleted: z.boolean(),
});

export type Task = z.infer<typeof taskSchema>;

// Define collection type with TanStack DB discriminator
type TasksCollection = Collection<Task> & {
  singleResult?: never;
};

// Module-level singleton to prevent multiple collection instances
let tasksCollection: TasksCollection | null = null;

// Initialize persistence (SQLite for browser)
import initSqlJs from 'sql.js';
const SQL = await initSqlJs({ locateFile: (file) => `/${file}` });
const tasksPersistence = await persistence.sqlite.browser(SQL, 'tasks-db');

export function useTasks(
  initialData?: { documents: Task[], cursor?: number, count?: number, crdtBytes?: ArrayBuffer }
) {
  return useMemo(() => {
    if (!tasksCollection) {
      tasksCollection = createCollection(
        convexCollectionOptions({
          schema: taskSchema,           // Required: Zod schema
          getKey: (task) => task.id,
          convexClient,
          api: api.tasks,               // Collection name auto-extracted from function path
          persistence: tasksPersistence, // Required: SQLite, memory, or custom
          material: initialData,
        })
      ) as unknown as TasksCollection;
    }
    return tasksCollection;
  }, [initialData]);
}
```

**Key differences from previous versions:**
- `schema` is now **required** (Zod schema for type inference and prose field detection)
- `collection` prop removed (auto-extracted from `api.stream` function path)
- `prose` prop removed (auto-detected from schema fields using `prose()` type)
- `persistence` is now **required** (SQLite, memory, or custom adapter)

### Step 5: Use in Components

```typescript
// src/routes/index.tsx
import { useLiveQuery } from '@tanstack/react-db';
import { useTasks } from '../useTasks';

export function TaskList() {
  const collection = useTasks();
  const { data: tasks, isLoading, isError } = useLiveQuery(collection);

  const handleCreate = () => {
    collection.insert({
      id: crypto.randomUUID(),
      text: 'New task',
      isCompleted: false,
    });
  };

  const handleUpdate = (id: string, isCompleted: boolean) => {
    collection.update(id, (draft: Task) => {
      draft.isCompleted = !isCompleted;
    });
  };

  const handleDelete = (id: string) => {
    // Hard delete - physically removes from main table
    collection.delete(id);
  };

  if (isError) {
    return <div>Error loading tasks. Please refresh.</div>;
  }

  if (isLoading) {
    return <div>Loading tasks...</div>;
  }

  return (
    <div>
      <button onClick={handleCreate}>Add Task</button>

      {tasks.map((task) => (
        <div key={task.id}>
          <input
            type="checkbox"
            checked={task.isCompleted}
            onChange={() => handleUpdate(task.id, task.isCompleted)}
          />
          <span>{task.text}</span>
          <button onClick={() => handleDelete(task.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
```

### Step 6: Server-Side Rendering (Recommended)

For frameworks that support SSR (TanStack Start, Next.js, Remix, SvelteKit), preloading data on the server is the recommended approach for instant page loads and better SEO.

**Why SSR is recommended:**
- **Instant page loads** - No loading spinners on first render
- **Better SEO** - Content visible to search engines
- **Reduced client work** - Data already available on hydration
- **Seamless transition** - Real-time sync takes over after hydration

**Step 1: Use the `material` query from replicate()**

The `material` query is automatically generated by `replicate()` and returns all documents for SSR hydration.

**Step 2: Load data in your route loader**

```typescript
// src/routes/index.tsx
import { createFileRoute } from '@tanstack/react-router';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import type { Task } from '../useTasks';

const httpClient = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL);

export const Route = createFileRoute('/')({
  loader: async () => {
    const tasks = await httpClient.query(api.tasks.material);
    return { tasks };
  },
});

function TasksPage() {
  const { tasks: initialTasks } = Route.useLoaderData();

  // Pass initialData to your hook - no loading state on first render!
  const collection = useTasks(initialTasks);
  const { data: tasks } = useLiveQuery(collection);

  return <TaskList tasks={tasks} />;
}
```

**Note:** If your framework doesn't support SSR, the collection works just fine without `initialData` - it will fetch data on mount and show a loading state.

## Sync Protocol

Replicate uses cursor-based sync with peer tracking for safe compaction.

### `stream` - Cursor-Based Real-Time Sync

The primary sync mechanism uses monotonically increasing sequence numbers (`seq`):

1. Client subscribes with last known `cursor` (seq number)
2. Server returns all changes with `seq > cursor`
3. Client applies changes and updates local cursor
4. Client calls `mark` to report sync progress to server
5. Subscription stays open for live updates

This approach enables:
- **Safe compaction**: Server knows which deltas each peer has synced
- **Peer tracking**: Active peers are tracked via `mark` calls
- **No data loss**: Compaction only removes deltas all active peers have received

### `mark` - Peer Sync Tracking

Clients report their sync progress to the server:

```typescript
// Called automatically after applying changes
await convexClient.mutation(api.tasks.mark, {
  peerId: "client-uuid",
  syncedSeq: 42,  // Last processed seq number
});
```

The server tracks:
- Which peers are actively syncing
- Each peer's last synced `seq` number
- Peer timeout for cleanup (configurable via `peerTimeout`)

### `compact` - Peer-Aware Compaction

Compaction is safe because it respects peer sync state:

1. Server checks minimum `syncedSeq` across all active peers
2. Only deletes deltas where `seq < minSyncedSeq`
3. Ensures no active peer loses data they haven't synced

**Compaction triggers:**
- **Automatic**: When document deltas exceed `sizeThreshold`
- **Manual**: Via `compact` mutation

### `recovery` - State Vector Sync

Used on startup to reconcile client and server state using Yjs state vectors:

1. Client encodes its local Y.Doc state vector (compact representation of what it has)
2. Server merges all snapshots + deltas into full state
3. Server computes diff between its state and client's state vector
4. Server returns only the missing bytes
5. Client applies the diff to catch up

**When recovery is used:**
- App startup (before stream subscription begins)
- After extended offline periods
- When cursor-based sync can't satisfy the request (deltas compacted)

## Delete Pattern: Hard Delete with Event History

Replicate uses **hard deletes** where items are physically removed from the main table, while the internal component preserves complete event history.

**Why hard delete?**
- Clean main table (no filtering required)
- Standard TanStack DB operations
- Complete audit trail preserved in component event log
- Proper CRDT conflict resolution maintained
- Foundation for future recovery features

**Implementation:**

```typescript
// Delete handler (uses collection.delete)
const handleDelete = (id: string) => {
  collection.delete(id);  // Hard delete - physically removes from main table
};

// UI usage - no filtering needed!
const { data: tasks } = useLiveQuery(collection);

// SSR loader - no filtering needed!
export const Route = createFileRoute('/')({
  loader: async () => {
    const tasks = await httpClient.query(api.tasks.material);
    return { tasks };
  },
});
```

**How it works:**
1. Client calls `collection.delete(id)`
2. `onRemove` handler captures Yjs deletion delta
3. Delta appended to component event log (history preserved)
4. Main table: document physically removed
5. Other clients notified and item removed locally

## Advanced Usage

### Custom Hooks and Lifecycle Events

You can customize the behavior of generated functions using optional hooks:

```typescript
// convex/tasks.ts
import { replicate } from '@trestleinc/replicate/server';
import { components } from './_generated/api';
import type { Task } from '../src/useTasks';

const r = replicate(components.replicate);

export const {
  stream,
  material,
  recovery,
  insert,
  update,
  remove,
  mark,
  compact,
} = r<Task>({
  collection: 'tasks',

  // Optional hooks for authorization and lifecycle events
  hooks: {
    // Permission checks (eval* hooks validate BEFORE execution, throw to deny)
    evalRead: async (ctx, collection) => {
      const userId = await ctx.auth.getUserIdentity();
      if (!userId) throw new Error('Unauthorized');
    },
    evalWrite: async (ctx, doc) => {
      const userId = await ctx.auth.getUserIdentity();
      if (!userId) throw new Error('Unauthorized');
    },
    evalRemove: async (ctx, documentId) => {
      const userId = await ctx.auth.getUserIdentity();
      if (!userId) throw new Error('Unauthorized');
    },
    evalMark: async (ctx, peerId) => {
      // Validate peer identity
      const userId = await ctx.auth.getUserIdentity();
      if (!userId) throw new Error('Unauthorized');
    },
    evalCompact: async (ctx, documentId) => {
      // Restrict compaction to admin users
      const userId = await ctx.auth.getUserIdentity();
      if (!userId) throw new Error('Unauthorized');
    },

    // Lifecycle callbacks (on* hooks run AFTER execution)
    onStream: async (ctx, result) => { /* after stream query */ },
    onInsert: async (ctx, doc) => { /* after insert */ },
    onUpdate: async (ctx, doc) => { /* after update */ },
    onRemove: async (ctx, documentId) => { /* after remove */ },

    // Transform hook (modify documents before returning)
    transform: async (docs) => docs.filter(d => d.isPublic),
  }
});
```

### Rich Text / Prose Fields

For collaborative rich text editing, use the `schema.prose()` validator and `prose.extract()` function:

```typescript
// convex/schema.ts
import { schema } from '@trestleinc/replicate/server';

export default defineSchema({
  notebooks: schema.table({
    id: v.string(),
    title: v.string(),
    content: schema.prose(),  // ProseMirror-compatible JSON
  }),
});

// Client: Extract plain text for search
import { prose } from '@trestleinc/replicate/client';

const plainText = prose.extract(notebook.content);

// Client: Get editor binding for ProseMirror/TipTap
const binding = await collection.utils.prose(notebookId, 'content');
```

### Persistence Providers

Choose the right storage backend for your platform:

```typescript
import { persistence, adapters } from '@trestleinc/replicate/client';

// Browser SQLite: Uses sql.js WASM with OPFS persistence
import initSqlJs from 'sql.js';
const SQL = await initSqlJs({ locateFile: (file) => `/${file}` });
convexCollectionOptions({
  // ... other options
  persistence: await persistence.sqlite.browser(SQL, 'my-app-db'),
});

// React Native SQLite: Uses op-sqlite (native SQLite)
import { open } from '@op-engineering/op-sqlite';
const db = open({ name: 'my-app-db' });
convexCollectionOptions({
  // ... other options
  persistence: await persistence.sqlite.native(db, 'my-app-db'),
});

// Testing: In-memory (no persistence)
convexCollectionOptions({
  // ... other options
  persistence: persistence.memory(),
});

// Custom backend: Implement StorageAdapter interface
convexCollectionOptions({
  // ... other options
  persistence: persistence.custom(new MyCustomAdapter()),
});
```

**SQLite Browser** - Uses sql.js (SQLite compiled to WASM) with OPFS persistence. You initialize sql.js yourself and pass the SQL object.

**SQLite Native** - Uses op-sqlite for React Native. You create the database and pass it.

**Memory** - No persistence, useful for testing.

**Custom** - Implement `StorageAdapter` for any storage backend.

### Custom Storage Backends

Implement `StorageAdapter` for custom storage (Chrome extensions, localStorage, cloud storage):

```typescript
import { persistence, type StorageAdapter } from '@trestleinc/replicate/client';

class ChromeStorageAdapter implements StorageAdapter {
  async get(key: string): Promise<Uint8Array | undefined> {
    const result = await chrome.storage.local.get(key);
    return result[key] ? new Uint8Array(result[key]) : undefined;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await chrome.storage.local.set({ [key]: Array.from(value) });
  }

  async delete(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }

  async keys(prefix: string): Promise<string[]> {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter(k => k.startsWith(prefix));
  }
}

// Use custom adapter
const chromePersistence = persistence.custom(new ChromeStorageAdapter());
```

### Logging Configuration

Configure logging for debugging and development using LogTape:

```typescript
// src/routes/__root.tsx or app entry point
import { configure, getConsoleSink } from '@logtape/logtape';

await configure({
  sinks: { console: getConsoleSink() },
  loggers: [
    {
      category: ['convex-replicate'],
      lowestLevel: 'debug',  // 'debug' | 'info' | 'warn' | 'error'
      sinks: ['console']
    }
  ],
});
```

## API Reference

### Client-Side (`@trestleinc/replicate/client`)

#### `collection.create({ persistence, config })`

Creates a lazy-initialized collection with deferred persistence and config resolution. Both `persistence` and `config` are factory functions that are only called when `init()` is invoked (browser-only).

**Parameters:**
- `persistence` - Async factory function that returns a `Persistence` instance
- `config` - Sync factory function that returns the collection config (ConvexClient, schema, api, etc.)

**Returns:** `LazyCollection` with `init(material?)` and `get()` methods

**Example:**
```typescript
import { collection, persistence } from '@trestleinc/replicate/client';
import { ConvexClient } from 'convex/browser';
import initSqlJs from 'sql.js';

export const tasks = collection.create({
  persistence: async () => {
    const SQL = await initSqlJs({ locateFile: (f) => `/${f}` });
    return persistence.sqlite.browser(SQL, 'tasks');
  },
  config: () => ({
    schema: taskSchema,
    convexClient: new ConvexClient(import.meta.env.VITE_CONVEX_URL),
    api: api.tasks,
    getKey: (task) => task.id,
  }),
});

// In your app initialization (browser only):
// Pass SSR-prefetched material for instant hydration
await tasks.init(material);
const collection = tasks.get();
```

**SSR Prefetch (server-side):**
```typescript
// SvelteKit: +layout.server.ts
import { ConvexHttpClient } from 'convex/browser';
const httpClient = new ConvexHttpClient(PUBLIC_CONVEX_URL);

export async function load() {
  const material = await httpClient.query(api.tasks.material);
  return { material };
}
```

#### `convexCollectionOptions<TSchema>(config)`

Creates collection options for TanStack DB with Yjs CRDT integration.

**Config:**
```typescript
interface ConvexCollectionOptionsConfig<T> {
  schema: ZodObject;              // Required: Zod schema for type inference
  getKey: (item: T) => string | number;
  convexClient: ConvexClient;
  api: {
    stream: FunctionReference;    // Real-time subscription endpoint
    insert: FunctionReference;    // Insert mutation
    update: FunctionReference;    // Update mutation
    remove: FunctionReference;    // Delete mutation
    recovery: FunctionReference;  // State vector sync
    mark: FunctionReference;      // Peer sync tracking
    compact: FunctionReference;   // Manual compaction
    material?: FunctionReference; // SSR hydration query
  };
  persistence: Persistence;       // Required: SQLite, memory, or custom
  material?: Materialized<T>;     // SSR hydration data
  undoCaptureTimeout?: number;    // Undo stack merge window (default: 500ms)
}
```

**Returns:** Collection options for `createCollection()`

**Example:**
```typescript
const taskSchema = z.object({
  id: z.string(),
  text: z.string(),
  content: prose(),  // Auto-detected as prose field
});

const collection = createCollection(
  convexCollectionOptions({
    schema: taskSchema,
    getKey: (task) => task.id,
    convexClient,
    api: api.tasks,
    persistence: await persistence.sqlite.browser(SQL, 'tasks'),
  })
);
```

#### `prose.extract(proseJson)`

Extract plain text from ProseMirror JSON.

**Parameters:**
- `proseJson` - ProseMirror JSON structure (XmlFragmentJSON)

**Returns:** `string` - Plain text content

**Example:**
```typescript
import { prose } from '@trestleinc/replicate/client';

const plainText = prose.extract(task.content);
```

#### Persistence Providers

```typescript
import { persistence, adapters, type StorageAdapter } from '@trestleinc/replicate/client';

// Persistence providers
persistence.sqlite.browser(SQL, name)  // Browser: sql.js WASM + OPFS
persistence.sqlite.native(db, name)    // React Native: op-sqlite
persistence.memory()                   // Testing: in-memory (no persistence)
persistence.custom(adapter)            // Custom: your StorageAdapter implementation

// SQLite adapters (for advanced use)
adapters.sqljs    // SqlJsAdapter class for browser
adapters.opsqlite // OPSqliteAdapter class for React Native
```

**`persistence.sqlite.browser(SQL, name)`** - Browser SQLite using sql.js WASM. You initialize sql.js and pass the SQL object.

**`persistence.sqlite.native(db, name)`** - React Native SQLite using op-sqlite. You create the database and pass it.

**`persistence.memory()`** - In-memory, no persistence. Useful for testing.

**`persistence.custom(adapter)`** - Custom storage backend. Pass your `StorageAdapter` implementation.

#### `StorageAdapter` Interface

Implement for custom storage backends:

```typescript
interface StorageAdapter {
  /** Get value by key, returns undefined if not found */
  get(key: string): Promise<Uint8Array | undefined>;

  /** Set value by key */
  set(key: string, value: Uint8Array): Promise<void>;

  /** Delete value by key */
  delete(key: string): Promise<void>;

  /** List all keys matching prefix */
  keys(prefix: string): Promise<string[]>;

  /** Optional: cleanup when persistence is destroyed */
  close?(): void;
}
```

#### Error Classes

```typescript
import { errors } from '@trestleinc/replicate/client';

errors.Network           // Network-related failures
errors.IDB               // Storage read errors
errors.IDBWrite          // Storage write errors
errors.Reconciliation    // Phantom document cleanup errors
errors.Prose             // Rich text field errors
errors.CollectionNotReady// Collection not initialized
errors.NonRetriable      // Errors that should not be retried (auth, validation)
```

### Server-Side (`@trestleinc/replicate/server`)

#### `replicate(component)`

Factory function that creates a bound replicate function for your collections.

**Parameters:**
- `component` - Your Convex component reference (`components.replicate`)

**Returns:** A function `<T>(config: ReplicateConfig<T>)` that generates collection operations.

**Example:**
```typescript
import { replicate } from '@trestleinc/replicate/server';
import { components } from './_generated/api';

const r = replicate(components.replicate);
export const tasks = r<Task>({ collection: 'tasks' });
```

#### `ReplicateConfig<T>`

Configuration for the bound replicate function.

**Config:**
```typescript
interface ReplicateConfig<T> {
  collection: string;          // Collection name (e.g., 'tasks')

  // Optional: Compaction settings with type-safe values
  compaction?: {
    sizeThreshold?: Size;      // Size threshold: "100kb", "5mb", "1gb" (default: "5mb")
    peerTimeout?: Duration;    // Peer timeout: "30m", "24h", "7d" (default: "24h")
  };

  // Optional: Hooks for permissions and lifecycle
  hooks?: {
    // Permission checks (throw to reject)
    evalRead?: (ctx, collection) => Promise<void>;
    evalWrite?: (ctx, doc) => Promise<void>;
    evalRemove?: (ctx, documentId) => Promise<void>;
    evalMark?: (ctx, peerId) => Promise<void>;
    evalCompact?: (ctx, documentId) => Promise<void>;

    // Lifecycle callbacks (run after operation)
    onStream?: (ctx, result) => Promise<void>;
    onInsert?: (ctx, doc) => Promise<void>;
    onUpdate?: (ctx, doc) => Promise<void>;
    onRemove?: (ctx, documentId) => Promise<void>;

    // Transform hook (modify documents before returning)
    transform?: (docs) => Promise<T[]>;
  };
}
```

**Type-safe values:**
- `Size`: `"100kb"`, `"5mb"`, `"1gb"`, etc.
- `Duration`: `"30m"`, `"24h"`, `"7d"`, etc.

**Returns:** Object with generated functions:
- `stream` - Real-time CRDT stream query (cursor-based with `seq` numbers)
- `material` - SSR-friendly query for hydration
- `recovery` - State vector sync query (for startup reconciliation)
- `insert` - Dual-storage insert mutation (auto-compacts when threshold exceeded)
- `update` - Dual-storage update mutation (auto-compacts when threshold exceeded)
- `remove` - Dual-storage delete mutation (auto-compacts when threshold exceeded)
- `mark` - Peer sync tracking mutation (reports `syncedSeq` to server)
- `compact` - Manual compaction mutation (peer-aware, safe for active clients)

#### `schema.table(userFields, applyIndexes?)`

Automatically inject `timestamp` field for incremental sync.

**Parameters:**
- `userFields` - User's business logic fields
- `applyIndexes` - Optional callback to add indexes

**Returns:** TableDefinition with replication fields injected

**Example:**
```typescript
import { schema } from '@trestleinc/replicate/server';

tasks: schema.table(
  {
    id: v.string(),
    text: v.string(),
  },
  (t) => t
    .index('by_doc_id', ['id'])
    .index('by_timestamp', ['timestamp'])
)
```

#### `schema.prose()`

Validator for ProseMirror-compatible JSON fields.

**Returns:** Convex validator for prose fields

**Example:**
```typescript
content: schema.prose()  // Validates ProseMirror JSON structure
```

### Shared Types (`@trestleinc/replicate/shared`)

```typescript
import type { ProseValue } from '@trestleinc/replicate/shared';

// ProseValue - branded type for prose fields in Zod schemas
// Use the prose() helper from client to create fields of this type
```

## Examples

### Interval - Linear-style Issue Tracker

A full-featured offline-first issue tracker built with Replicate, demonstrating real-world usage patterns.

**Live Demo:** [interval.robelest.com](https://interval.robelest.com)

**Source Code:** Available in two framework variants:
- [`illustrations/web/tanstack-start/`](./illustrations/web/tanstack-start/) - TanStack Start (React)
- [`illustrations/web/sveltekit/`](./illustrations/web/sveltekit/) - SvelteKit (Svelte)

**Features demonstrated:**
- Offline-first with SQLite persistence (sql.js + OPFS)
- Rich text editing with TipTap + Yjs collaboration
- PWA with custom service worker
- Real-time sync across devices
- Search with client-side text extraction (`prose.extract()`)

## Development

```bash
bun run build         # Build with tsdown (includes ESLint + TypeScript checking)
bun run dev           # Watch mode
bun run clean         # Remove build artifacts
```

## License

Apache-2.0 License - see [LICENSE](./LICENSE) file for details.

Copyright 2025 Trestle Inc
