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
# Build
bun run build        # Build with Rslib (outputs to dist/)
bun run clean        # Remove dist/

# Code Quality (Biome v2)
bun run check        # Lint + format check (dry run)
bun run check:fix    # Auto-fix all issues (ALWAYS run before committing)

# Testing
bun test             # Run all tests with Vitest
bun test <path>      # Run specific test file

# Publishing
bun run prepublish   # Build + check:fix (runs before npm publish)
```

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
│       ├── checkpoint.ts    # Sync checkpoints in persistence KV
│       ├── snapshot.ts      # Snapshot recovery
│       └── reconciliation.ts # Phantom document cleanup
├── server/                  # Server-side (Convex functions)
│   ├── index.ts             # Public exports
│   ├── builder.ts           # replicate() factory
│   ├── schema.ts            # table(), prose() helpers
│   └── storage.ts           # Replicate class (storage operations)
├── component/               # Internal Convex component
│   ├── convex.config.ts     # Component config
│   ├── schema.ts            # Event log schema (documents, snapshots, versions)
│   ├── public.ts            # Component API (stream, insertDocument, etc.)
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
- `Checkpoint` - manages sync checkpoints in IndexedDB
- `Snapshot` - recovers from server snapshots
- `Reconciliation` - removes phantom documents

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
convexCollectionOptions()    // Create collection options for TanStack DB

// Persistence providers (swappable storage backends)
indexeddbPersistence()       // Browser: IndexedDB (default)
sqlitePersistence()          // Universal: SQLite (browser + React Native)
memoryPersistence()          // Testing: in-memory

// Text extraction
extract()                    // Extract plain text from ProseMirror JSON

// Effect TaggedErrors
NetworkError
IDBError
IDBWriteError
ReconciliationError
ProseError
CollectionNotReadyError
NonRetriableError            // Error that should not be retried

// Collection utils (accessed via collection.utils.*)
collection.utils.prose(id, field)   // Returns EditorBinding for rich text
```

### Server (`@trestleinc/replicate/server`)
```typescript
replicate()             // Factory to create bound replicate function
table()                 // Define replicated table schema (injects version/timestamp fields)
prose()                 // Validator for ProseMirror-compatible JSON

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
  insert,      // Dual-storage insert mutation
  update,      // Dual-storage update mutation
  remove,      // Dual-storage delete mutation
  compact,     // Compaction mutation (internal, for cron jobs)
  prune,       // Snapshot cleanup mutation (internal, for cron jobs)
  snapshot: {
    create,    // Create a version snapshot
    list,      // List versions for a document
    get,       // Get a specific version
    restore,   // Restore a document to a version
    remove,    // Delete a version
    prune,     // Prune old versions
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
export const { stream, material, insert, update, remove, snapshot } =
  r<Task>({ collection: 'tasks' });
```

### Client: Collection Setup
```typescript
import { convexCollectionOptions } from '@trestleinc/replicate/client';

const collection = createCollection(
  convexCollectionOptions<Task>({
    convexClient,
    api: api.tasks,
    collection: 'tasks',
    prose: ['content'],  // optional: prose fields for rich text
    getKey: (task) => task.id,
  })
);

// Access utils methods
const binding = await collection.utils.prose(id, 'content');  // Editor binding
```

### Schema: table() Helper
```typescript
import { table, prose } from '@trestleinc/replicate/server';

// Automatically injects version and timestamp fields
tasks: table({
  id: v.string(),
  text: v.string(),
  content: prose(),  // optional: ProseMirror-compatible rich text
}, (t) => t.index('by_id', ['id']))
```

### Text Extraction
```typescript
import { extract } from '@trestleinc/replicate/client';

// Extract plain text from ProseMirror JSON
const plainText = extract(task.content);
```

## Technology Stack

- **TypeScript** (strict mode)
- **Effect** for service architecture and dependency injection
- **Yjs** for CRDTs (conflict-free replicated data types)
- **Convex** for backend (cloud database + functions)
- **TanStack DB** for reactive state management
- **Rslib** for building
- **Biome** for linting/formatting
- **LogTape** for logging (avoid console.*)

## Naming Conventions

- **Public API**: Single-word function names (`replicate()`, `table()`, `extract()`)
- **Service files**: lowercase, no suffix (`checkpoint.ts`, not `CheckpointService.ts`)
- **Service exports**: PascalCase, no "Service" suffix (`Checkpoint`, `CheckpointLive`)
- **Error classes**: Short names with "Error" suffix (`ProseError`, not `ProseFieldNotFoundError`)
- **Use "replicate"**: not "sync" throughout the codebase

## Important Notes

- **Effect-based services** - Client services use Effect for DI; understand Effect basics
- **Hard deletes** - Documents physically removed from main table, history kept in component
- **Biome config** - `noExplicitAny` OFF, `noConsole` warns (except in test files and component logger)
- **LogTape logging** - Use LogTape, not console.* (Biome warns on console)
- **Import types** - Use `import type` for type-only imports (Biome enforces this)
- **bun for commands** - Use `bun run` not `pnpm run` for all commands
