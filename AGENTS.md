# AGENTS.md - Development Guide

## Commands

- **Build:** `bun run build` (uses tsdown, outputs to `dist/`)
- **Lint & Format:** `bun run lint:fix` (ESLint + Stylistic) - **ALWAYS RUN BEFORE COMMITTING**
- **Type Check:** Build includes type checking via tsdown

## Code Style & Conventions

- **Formatting:** 2 spaces, double quotes, semicolons (enforced by ESLint Stylistic)
- **Imports:** Use `import type` for types. Use `node:` protocol for Node built-ins
- **Logging:** Use `LogTape`. Avoid `console.*` (warns in ESLint)
- **Structure:** Single package. `src/client` (browser), `src/server` (Convex), `src/component`
- **Documentation:** ALWAYS use `Context7` tool for library docs (Convex, Yjs, TanStack, Effect)
- **Deletion:** Hard deletes in main table; soft deletes (append-only) in component

## Architecture

### Client Services (`src/client/services/`)

The sync system uses Effect.ts per-document actors:

| File           | Purpose                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `actor.ts`     | DocumentActor - per-document sync with Queue batching                   |
| `manager.ts`   | ActorManager - manages actor lifecycle via HashMap                      |
| `runtime.ts`   | ReplicateRuntime - Effect runtime factory (per-collection or singleton) |
| `errors.ts`    | Effect TaggedError types (SyncError, ActorShutdownError, etc.)          |
| `engine.ts`    | Barrel file re-exporting actor system                                   |
| `context.ts`   | CollectionContext - consolidated collection state                       |
| `seq.ts`       | SeqService - cursor/sequence number tracking                            |
| `session.ts`   | Session management helpers                                              |
| `awareness.ts` | Yjs awareness/presence                                                  |

### Actor Model

```
LocalChange → Queue.offer → debounce (200ms) → Queue.takeAll (batch) → sync → update vector
ExternalUpdate → Queue.offer → update stored vector (Yjs already applied)
Shutdown → interrupt debounce → signal done via Deferred
```

Key patterns:

- `Queue.takeAll` batches rapid local changes into single sync
- `SubscriptionRef` for reactive pending state
- `Schedule.exponential` with jitter for retry
- Each actor has own `Scope` for cleanup

## Public API

### Server (`@trestleinc/replicate/server`)

```typescript
replicate()              // Factory to create bound replicate function
schema.table()           // Define replicated table schema (injects timestamp)
schema.prose()           // Validator for prose fields
```

### Client (`@trestleinc/replicate/client`)

```typescript
collection.create()              // Main entry point - create lazy-initialized collections
persistence.web.sqlite()         // Browser wa-sqlite Web Worker + OPFSCoopSyncVFS
persistence.web.sqlite.once()    // SQLite singleton mode (shared across collections)
persistence.web.encrypted()      // Browser encrypted storage (WebAuthn PRF)
persistence.native.sqlite()      // React Native SQLite persistence (op-sqlite)
persistence.native.encrypted()   // React Native encrypted storage (not yet implemented)
persistence.memory()             // In-memory persistence (testing)
persistence.custom()             // Custom storage adapter
schema.prose()               // Zod schema for prose fields
schema.prose.extract()       // Extract plain text from prose JSON
schema.prose.empty()         // Create empty prose value
```

## Critical Rules

- NEVER use WebSearch for library documentation; use Context7
- Examples use `bun` and link to root via `file:../..`
- Use `table()` helper for schemas to inject version/timestamp
- Effect.ts actors handle sync - understand Queue, SubscriptionRef, Schedule patterns
