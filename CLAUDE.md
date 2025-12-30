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

# Publishing
bun run prepublish   # Runs build (which includes linting)
```

**Note:** Build uses tsdown which includes TypeScript type checking. Linting runs separately via `bun run lint`.

## Architecture

### Package Structure
```
src/
├── client/                  # Client-side (browser)
│   ├── index.ts             # Public exports
│   ├── collection.ts        # TanStack DB + Yjs integration, utils.prose()
│   ├── replicate.ts         # Replicate helpers for TanStack DB
│   ├── merge.ts             # Yjs CRDT merge operations, extract()
│   ├── errors.ts            # Effect TaggedErrors + NonRetriableError
│   ├── logger.ts            # LogTape logger
│   ├── persistence/         # Swappable storage backends
│   │   ├── types.ts         # Persistence, PersistenceProvider, KeyValueStore
│   │   ├── indexeddb.ts     # Browser: y-indexeddb + browser-level
│   │   ├── sqlite.ts        # Universal: y-leveldb + sqlite-level (browser + RN)
│   │   ├── sqlite-level.ts  # abstract-level implementation for SQLite
│   │   ├── adapters/
│   │   │   ├── sqljs.ts     # Browser: sql.js WASM adapter with OPFS
│   │   │   └── opsqlite.ts  # React Native: op-sqlite native adapter
│   │   └── memory.ts        # Testing: in-memory (no persistence)
│   └── services/            # Core services (Effect-based)
│       ├── context.ts       # CollectionContext for consolidated state
│       ├── cursor.ts        # Cursor/Seq tracking in persistence KV
│       ├── presence.ts      # Real-time cursor presence
│       └── sync.ts          # Sync subscription and recovery (Phase 2)
├── server/                  # Server-side (Convex functions)
│   ├── index.ts             # Public exports
│   ├── collection.ts        # replicate() factory
│   ├── schema.ts            # table(), prose() helpers
│   └── replicate.ts         # Replicate class (storage operations)
├── component/               # Internal Convex component
│   ├── convex.config.ts     # Component config
│   ├── schema.ts            # Event log schema (documents, snapshots, sessions)
│   ├── mutations.ts         # Component API (stream, insert, update, etc.)
│   └── logger.ts            # Component logging
├── shared/                  # Shared types (all environments)
│   ├── index.ts             # Re-exports types.ts
│   └── types.ts             # ProseFields, XmlFragmentJSON, OperationType
├── test/                    # Test files
│   ├── e2e/                 # End-to-end tests
│   ├── integration/         # Integration tests
│   └── unit/                # Unit tests
└── env.d.ts                 # Environment type declarations
```

### Core Concepts

**Event-Sourced Dual Storage:**
- Component storage: Append-only Yjs CRDT deltas (event log)
- Main table: Materialized documents (read model)
- Similar to CQRS pattern

**Client Services (Effect-based):**
- Services in `src/client/services/` use Effect for dependency injection
- `Cursor` - manages sync sequence numbers (Seq) in persistence KV
- `Context` - consolidated CollectionContext for module state
- `Presence` - real-time cursor position sharing

**Data Flow:**
```
Client edit -> merge.ts (encode delta) -> collection.ts -> TanStack DB sync
    -> Convex mutation -> Component (append delta) + Main table (upsert)
    -> Subscription -> Other clients
```

## Public API Surface

### Client (`@trestleinc/replicate/client`)
```typescript
// Main entry point
collection.create()           // Create lazy-initialized collection (SSR-safe)

// Persistence providers (nested object)
persistence.indexeddb()              // Browser: IndexedDB (default)
persistence.sqlite.browser(SQL, name) // Browser: sql.js WASM + OPFS
persistence.sqlite.native(db, name)   // React Native: op-sqlite
persistence.memory()                  // Testing: in-memory
persistence.custom(adapter)           // Custom storage adapter

// Prose utilities
prose()                      // Zod schema for prose fields
prose.extract()              // Extract plain text from ProseMirror JSON
prose.empty()                // Create empty prose value
```

### Server (`@trestleinc/replicate/server`)
```typescript
replicate()             // Factory to create bound replicate function

// Schema helpers (nested object)
schema.table()          // Define replicated table schema (injects version/timestamp fields)
schema.prose()          // Validator for ProseMirror-compatible JSON

// Type exports
ReplicateConfig         // Configuration type for replicate
ReplicationFields       // Type for version + timestamp fields
```

### Shared (`@trestleinc/replicate/shared`)
```typescript
// Types (safe for any environment)
ProseFields<T>      // Extract prose field names from document type
XmlFragmentJSON     // ProseMirror-compatible JSON structure
XmlNodeJSON         // ProseMirror node structure
FragmentValue       // Marker for fragment fields
OperationType       // Enum: Delta | Snapshot
```

### replicate() Return Value
```typescript
const {
  stream,      // Real-time CRDT stream query
  material,    // SSR-friendly query for hydration
  insert,      // Dual-storage insert mutation (auto-compacts when threshold exceeded)
  update,      // Dual-storage update mutation (auto-compacts when threshold exceeded)
  remove,      // Dual-storage delete mutation (auto-compacts when threshold exceeded)
  versions: {
    create,    // Create a version
    list,      // List versions for a document
    get,       // Get a specific version
    restore,   // Restore a document to a version
    remove,    // Delete a version
  }
} = replicate<T>({ collection: 'tasks' });
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

// Create lazy-initialized collection (SSR-safe)
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

// Access utils methods
const binding = await collection.utils.prose(id, 'content');
```

### Schema: schema.table() Helper
```typescript
import { schema } from '@trestleinc/replicate/server';

// Automatically injects version and timestamp fields
tasks: schema.table({
  id: v.string(),
  text: v.string(),
  content: schema.prose(),  // optional: ProseMirror-compatible rich text
}, (t) => t.index('by_id', ['id']))
```

### Text Extraction
```typescript
import { prose } from '@trestleinc/replicate/client';

// Extract plain text from ProseMirror JSON
const plainText = prose.extract(task.content);
```

## Technology Stack

- **TypeScript** (strict mode)
- **Effect** for service architecture and dependency injection
- **Yjs** for CRDTs (conflict-free replicated data types)
- **Convex** for backend (cloud database + functions)
- **TanStack DB** for reactive state management
- **tsdown** for building (with TypeScript type checking)
- **ESLint** for linting (runs separately via `bun run lint`)
- **LogTape** for logging (avoid console.*)

## Naming Conventions

- **Public API**: Single-word function names, nested under noun objects (`replicate()`, `schema.table()`, `prose.extract()`)
- **Service files**: lowercase, no suffix (`checkpoint.ts`, not `CheckpointService.ts`)
- **Service exports**: PascalCase, no "Service" suffix (`Checkpoint`, `CheckpointLive`)
- **Error classes**: Short names with "Error" suffix (`ProseError`, not `ProseFieldNotFoundError`)
- **Use "replicate"**: not "sync" throughout the codebase

## Important Notes

- **Effect-based services** - Client services use Effect for DI; understand Effect basics
- **Hard deletes** - Documents physically removed from main table, history kept in component
- **Linting runs separately** - ESLint runs via `bun run lint` (not during build)
- **LogTape logging** - Use LogTape, not console.*
- **Import types** - Use `import type` for type-only imports
- **bun for commands** - Use `bun run` not `pnpm run` for all commands
