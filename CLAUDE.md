# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important: Always Use Context7 for Library Documentation

**CRITICAL**: When looking up documentation for any library (Yjs, Convex, TanStack, etc.), ALWAYS use the Context7 MCP tool. NEVER use WebSearch for library documentation.

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
│   ├── persistence/         # Swappable storage backends
│   │   ├── types.ts         # Persistence, KeyValueStore interfaces
│   │   ├── sqlite/          # SQLite backends
│   │   │   ├── web.ts       # wa-sqlite Web Worker + OPFSCoopSyncVFS
│   │   │   ├── worker.ts    # Web Worker with wa-sqlite (CDN loaded)
│   │   │   ├── schema.ts    # SQLite schema + persistence providers
│   │   │   └── native.ts    # op-sqlite (React Native)
│   │   ├── memory.ts        # Testing: in-memory
│   │   └── custom.ts        # Custom adapter wrapper
│   └── services/            # Client services (sync, seq, session, etc.)
├── server/                  # Server-side (Convex functions)
│   ├── index.ts             # Public exports
│   ├── collection.ts        # replicate() factory
│   ├── schema.ts            # table(), prose() helpers
│   └── replicate.ts         # Replicate class (storage operations)
├── component/               # Internal Convex component
│   ├── convex.config.ts     # Component config
│   ├── schema.ts            # Event log schema
│   └── mutations.ts         # Component API
└── shared/                  # Shared types and utilities
    ├── index.ts             # Public exports (validators, types, logger)
    └── logger.ts            # Unified LogTape logger with ANSI colored output
```

### Sync Architecture

The sync system uses a **simple debounce-based sync manager** with per-document sync handlers.

#### Services (`src/client/services/`)

```
services/
├── sync.ts       # DocumentSync + SyncManager - per-document sync with debounce
├── seq.ts        # SeqService - cursor/sequence tracking (persists sync position)
├── context.ts    # CollectionContext - consolidated state
├── session.ts    # Session management helpers
└── awareness.ts  # Yjs awareness/presence
```

#### Sync Manager Design

**DocumentSync** (`sync.ts`):

- One sync handler per document (prose field)
- Simple `setTimeout` debouncing (default 200ms)
- Pending state with listener subscriptions
- Methods: `onLocalChange()`, `onServerUpdate()`, `isPending()`, `onPendingChange()`, `destroy()`

**SyncManager** (`sync.ts`):

- Per-collection sync managers to avoid cross-collection conflicts
- Methods: `register`, `get`, `unregister`, `destroy`
- Module-level Map for collection isolation

**SeqService** (`seq.ts`):

- Tracks cursor/sequence numbers for sync progress
- Persists highest `seq` received from server
- Simple async interface: `load()`, `save()`, `clear()`

#### Error Types (`errors.ts`)

```typescript
NetworkError; // Retryable sync errors
IDBError; // Storage read errors
IDBWriteError; // Storage write errors
ProseError; // Rich text field binding issues
CollectionNotReadyError; // Collection not initialized
NonRetriableError; // Auth failures, validation errors
```

#### Data Flow

```
Client edit
    → Y.Doc update event
    → prose.ts captures delta
    → sync.onLocalChange()
    → debounce timer starts (200ms default)
    → (rapid edits restart the debounce timer)
    → debounce expires
    → performSync (encode delta, call Convex mutation)
    → set pending=false

Server update (via stream subscription)
    → collection.ts applies Y.applyUpdate to subdoc
    → ops.upsert/insert/delete to TanStack DB
    → sync.onServerUpdate() (no-op, Yjs already merged)
```

### Core Concepts

**Event-Sourced Dual Storage:**

- Component storage: Append-only Yjs CRDT deltas (event log)
- Main table: Materialized documents (read model)
- Similar to CQRS pattern

**CollectionContext** (`context.ts`):

- Consolidated state for each collection
- Replaces multiple module-level Maps
- Contains: subdocManager, convexClient, api, peerId, persistence, proseFields, mutex

## Public API Surface

### Client (`@trestleinc/replicate/client`)

```typescript
// Main entry point
collection.create(); // Create lazy-initialized collection (SSR-safe)

// Persistence providers (namespaced by platform)
persistence.web.sqlite(); // Browser: wa-sqlite Web Worker + OPFSCoopSyncVFS
persistence.web.sqlite.once(); // SQLite singleton (shared across collections)
persistence.web.encrypted(); // Browser: encrypted storage with WebAuthn PRF
persistence.native.sqlite(); // React Native: op-sqlite
persistence.native.encrypted(); // React Native: encrypted storage (not yet implemented)
persistence.memory(); // Testing: in-memory (cross-platform)
persistence.custom(); // Custom storage adapter (cross-platform)

// Schema helpers (matches server API)
schema.prose(); // Zod schema for prose fields
schema.prose.extract(); // Extract plain text from ProseMirror JSON
schema.prose.empty(); // Create empty prose value
```

### Server (`@trestleinc/replicate/server`)

```typescript
replicate(); // Factory to create bound replicate function

// Schema helpers
schema.table(); // Define replicated table schema
schema.prose(); // Validator for ProseMirror JSON
```

### Shared (`@trestleinc/replicate/shared`)

```typescript
ProseFields<T>; // Extract prose field names from document type
XmlFragmentJSON; // ProseMirror-compatible JSON structure
OperationType; // Enum: Delta | Snapshot
```

## Key Patterns

### Server: replicate Factory

```typescript
// convex/replicate.ts (create once)
import { replicate } from '@trestleinc/replicate/server';
import { components } from './_generated/api';

const r = replicate(components.replicate);

// convex/tasks.ts (use for each collection)
export const { stream, material, insert, update, remove, versions } = r<Task>({
	collection: 'tasks',
});
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

### Sync Registration (Internal)

```typescript
// prose.ts registers sync when binding is created
const syncManager = createSyncManager(collection);
const sync = syncManager.register(documentId, ydoc, syncFn);

// Pending state subscription for UI
const unsubscribe = sync.onPendingChange((pending) => {
	// Update UI indicator
});
```

## Naming Conventions

- **Public API**: Single-word function names, nested under noun objects (`replicate()`, `schema.table()`, `prose.extract()`)
- **Service files**: lowercase, no suffix (`sync.ts`, not `SyncService.ts`)
- **Error classes**: Short names with "Error" suffix (`NetworkError`, `IDBError`)
- **Use "replicate"**: not "sync" for public API

## Important Notes

- **Simple sync manager** - Per-document sync handlers with setTimeout debouncing
- **Debounce batching** - Rapid local changes coalesced into single sync (200ms default)
- **Hard deletes** - Documents physically removed from main table, history kept in component
- **Unified LogTape logging** - Import from `$/shared/logger`, not client or component. Use `getLogger(["category"])` for a LogTape Logger with ANSI colored console output
- **Import types** - Use `import type` for type-only imports
- **bun for commands** - Use `bun run` not `pnpm run` for all commands
- **No external deps for sync** - Sync system uses plain JavaScript (no Effect.ts)
