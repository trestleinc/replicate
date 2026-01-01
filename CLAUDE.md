# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important: Always Use Context7 for Library Documentation

**CRITICAL**: When looking up documentation for any library (Yjs, Convex, TanStack, Effect, etc.), ALWAYS use the Context7 MCP tool. NEVER use WebSearch for library documentation.

**Usage pattern:**
1. First resolve the library ID: `mcp__context7__resolve-library-id` with library name
2. Then fetch docs: `mcp__context7__get-library-docs` with the resolved ID and topic

## Project Overview

**Replicate** (`@trestleinc/replicate`) - Offline-first data replication using Yjs CRDTs and Convex for automatic conflict resolution and real-time synchronization.

Single package with exports:
- `@trestleinc/replicate/client` - Client utilities (browser/React/Svelte)
- `@trestleinc/replicate/server` - Server helpers (Convex functions)
- `@trestleinc/replicate/shared` - Shared types (ProseFields, XmlFragmentJSON, OperationType)
- `@trestleinc/replicate/convex.config` - Component configuration

## Development Commands

```bash
# Build (includes ESLint + TypeScript checking)
bun run build        # Build with tsdown (outputs to dist/)
bun run clean        # Remove dist/

# Linting
bun run lint         # Check for lint errors
bun run lint:fix     # Auto-fix lint errors
```

**Note:** Build uses tsdown which includes TypeScript type checking. Always run `bun run lint:fix` before committing.

## Architecture

### Package Structure
```
src/
├── client/                  # Client-side (browser)
│   ├── index.ts             # Public exports
│   ├── collection.ts        # TanStack DB + Yjs integration
│   ├── ops.ts               # Replicate helpers for TanStack DB
│   ├── merge.ts             # Yjs CRDT merge operations
│   ├── prose.ts             # Rich text field binding
│   ├── subdocs.ts           # Yjs subdoc management
│   ├── errors.ts            # Error classes
│   ├── logger.ts            # LogTape logger
│   ├── persistence/         # Swappable storage backends
│   │   ├── types.ts         # Persistence, KeyValueStore interfaces
│   │   ├── sqlite/          # SQLite backends
│   │   │   ├── browser.ts   # sql.js WASM + OPFS
│   │   │   └── native.ts    # op-sqlite (React Native)
│   │   ├── pglite.ts        # PGlite persistence
│   │   ├── memory.ts        # Testing: in-memory
│   │   └── custom.ts        # Custom adapter wrapper
│   └── services/            # Effect.ts services (see below)
├── server/                  # Server-side (Convex functions)
│   ├── index.ts             # Public exports
│   ├── collection.ts        # replicate() factory
│   ├── schema.ts            # table(), prose() helpers
│   └── replicate.ts         # Replicate class (storage operations)
├── component/               # Internal Convex component
│   ├── convex.config.ts     # Component config
│   ├── schema.ts            # Event log schema
│   └── mutations.ts         # Component API
└── shared/                  # Shared types
    └── types.ts             # ProseFields, XmlFragmentJSON, OperationType
```

### Effect.ts Actor-Based Sync Architecture

The sync system uses a **per-document actor model** built with Effect.ts primitives. This replaced the previous centralized sync engine with semaphores.

#### Services (`src/client/services/`)

```
services/
├── actor.ts      # DocumentActor - per-document sync actor
├── manager.ts    # ActorManager - manages actor lifecycle
├── runtime.ts    # ReplicateRuntime - Effect runtime factory
├── errors.ts     # Effect TaggedError types
├── engine.ts     # Re-exports (barrel file)
├── context.ts    # CollectionContext - consolidated state
├── seq.ts        # SeqService - cursor/sequence tracking
├── session.ts    # Session management helpers
└── awareness.ts  # Yjs awareness/presence
```

#### Actor Model Design

**DocumentActor** (`actor.ts`):
- One actor per document (prose field)
- Uses `Queue.unbounded` as mailbox for messages
- Message types: `LocalChange`, `ExternalUpdate`, `Shutdown`
- `Queue.takeAll` batches rapid local changes into single sync
- `SubscriptionRef` for reactive pending state (UI can subscribe)
- `Schedule.exponential` with jitter for retry on failure

```typescript
// Message flow
LocalChange → debounce (300ms) → batch with takeAll → sync → update vector
ExternalUpdate → update stored vector (Yjs already applied by collection.ts)
Shutdown → interrupt debounce fiber → signal done
```

**ActorManager** (`manager.ts`):
- Manages per-document actors with `HashMap<string, ManagedActor>`
- Methods: `register`, `get`, `onLocalChange`, `onServerUpdate`, `unregister`, `destroy`
- Each actor has its own `Scope` for resource cleanup

**ReplicateRuntime** (`runtime.ts`):
- Creates Effect runtime with `ActorManager` and `SeqService`
- Two modes:
  - **Per-collection** (default): Each collection gets its own runtime
  - **Singleton**: Shared runtime with reference counting (for PGlite)
- `runWithRuntime` helper for executing effects

#### Error Types (`errors.ts`)

```typescript
SyncError                  // Sync failed for document
DocumentNotRegisteredError // Document not registered with actor
ActorShutdownError         // Actor was shut down
ActorManagerError          // ActorManager operation failed
```

#### Data Flow

```
Client edit
    → Y.Doc update event
    → prose.ts captures delta
    → actorManager.onLocalChange(documentId)
    → actor.send({ _tag: "LocalChange" })
    → debounce timer starts
    → (more edits batch via Queue.takeAll)
    → debounce expires
    → performSync (encode delta, call Convex mutation)
    → update stored vector
    → set pending=false

Server update (via stream subscription)
    → collection.ts applies Y.applyUpdate to subdoc
    → ops.upsert/insert/delete to TanStack DB
    → actorManager.onServerUpdate(documentId)
    → actor updates stored vector (bookkeeping only)
```

### Core Concepts

**Event-Sourced Dual Storage:**
- Component storage: Append-only Yjs CRDT deltas (event log)
- Main table: Materialized documents (read model)
- Similar to CQRS pattern

**CollectionContext** (`context.ts`):
- Consolidated state for each collection
- Replaces multiple module-level Maps
- Contains: subdocManager, convexClient, api, peerId, persistence, proseFields, mutex, runtime, actorManager

## Public API Surface

### Client (`@trestleinc/replicate/client`)
```typescript
// Main entry point
collection.create()           // Create lazy-initialized collection (SSR-safe)

// Persistence providers
persistence.pglite()          // Browser: PGlite (PostgreSQL in IndexedDB)
persistence.pglite.once()     // PGlite singleton (shared across collections)
persistence.sqlite.native()   // React Native: op-sqlite
persistence.memory()          // Testing: in-memory
persistence.custom()          // Custom storage adapter

// Schema helpers (matches server API)
schema.prose()                // Zod schema for prose fields
schema.prose.extract()        // Extract plain text from ProseMirror JSON
schema.prose.empty()          // Create empty prose value
```

### Server (`@trestleinc/replicate/server`)
```typescript
replicate()                   // Factory to create bound replicate function

// Schema helpers
schema.table()                // Define replicated table schema
schema.prose()                // Validator for ProseMirror JSON
```

### Shared (`@trestleinc/replicate/shared`)
```typescript
ProseFields<T>                // Extract prose field names from document type
XmlFragmentJSON               // ProseMirror-compatible JSON structure
OperationType                 // Enum: Delta | Snapshot
```

## Key Patterns

### Server: replicate Factory
```typescript
// convex/replicate.ts (create once)
import { replicate } from '@trestleinc/replicate/server';
import { components } from './_generated/api';

const r = replicate(components.replicate);

// convex/tasks.ts (use for each collection)
export const { stream, material, insert, update, remove, versions } =
  r<Task>({ collection: 'tasks' });
```

### Client: Collection Setup
```typescript
import { collection, persistence } from '@trestleinc/replicate/client';
import { ConvexClient } from 'convex/browser';

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

// Initialize once during app startup (browser only)
await tasks.init();
const collection = tasks.get();

// Prose binding for rich text
const binding = await collection.utils.prose(id, 'content');
```

### Actor Registration (Internal)

```typescript
// prose.ts registers actor when binding is created
const actor = await runWithRuntime(
  ctx.runtime!,
  ctx.actorManager!.register(document, ydoc, syncFn)
);

// Pending state subscription for UI
const stream = SubscriptionRef.changes(actor.pending);
await runWithRuntime(
  ctx.runtime!,
  Stream.runForEach(stream, (pending) =>
    Effect.sync(() => callback(pending))
  )
);
```

## Naming Conventions

- **Public API**: Single-word function names, nested under noun objects (`replicate()`, `schema.table()`, `prose.extract()`)
- **Service files**: lowercase, no suffix (`actor.ts`, not `ActorService.ts`)
- **Effect services**: PascalCase class extending Context.Tag (`ActorManagerService`)
- **Error classes**: Short names with "Error" suffix (`SyncError`, `ActorShutdownError`)
- **Use "replicate"**: not "sync" for public API

## Important Notes

- **Effect.ts services** - Sync uses Effect for structured concurrency and resource management
- **Actor model** - One actor per document handles sync; messages processed sequentially (no races)
- **Hard deletes** - Documents physically removed from main table, history kept in component
- **LogTape logging** - Use LogTape, not console.*
- **Import types** - Use `import type` for type-only imports
- **bun for commands** - Use `bun run` not `pnpm run` for all commands
- **Queue.takeAll batching** - Rapid local changes coalesced into single sync
- **ExternalUpdate is bookkeeping** - Yjs update already applied by collection.ts; actor just updates vector
