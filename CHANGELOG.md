# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0-preview.0] - 2025-12-31

### Added

- **Presence via Yjs Awareness** - Real-time presence tracking using the standard Yjs Awareness protocol
- **Session tracking** - Per-document session management with `sessions` query (includes cursor data)
- **Unified `presence` mutation** - Join/leave presence with action discriminator (`{ action: "join" | "leave" }`)
- **Heartbeat cleanup** - Automatic removal of stale presence data
- **`pagehide` handler** - Reliable cleanup on tab close/navigation
- **Single-flight pattern** - Race-safe presence updates using convex-helpers pattern

### Changed

- **Migration V2 architecture** - Consolidated module-level state into `CollectionContext`
- **Per-document recovery** - Refactored SSR and recovery to per-document architecture
- **Normalized schema** - Aligned naming conventions and Effect.ts service patterns
- **Optimized SvelteKit example** - Added TanStack Table with virtual scrolling
- **Separated sync from presence** - `mark` mutation now only handles sync tracking (vector, seq); presence uses dedicated `presence` mutation

### Removed

- **`cursors` query** - Cursor data now included in `sessions` query
- **`leave` mutation** - Replaced by `presence({ action: "leave" })`

### Fixed

- **Avatar/presence bug** - Fixed `mark` mutation incorrectly setting `connected: true` for all synced documents, which caused wrong avatars to appear on refresh
- **Persistence race condition** - Documents no longer show as "Untitled" during init
- **Stream response types** - Aligned `replicate.ts` types with component
- **Presence race conditions** - Rewrote awareness.ts with atomic state machine (`idle → joining → active → leaving → destroyed`) to handle visibility changes, destroy during throttle, and overlapping heartbeats

## [1.1.2] - 2025-12-28

### Added

- **Cursor-based sync protocol** - Replaced `_creationTime` with monotonically increasing sequence numbers (`seq`) to ensure no updates are missed during sync
- **Peer tracking for safe compaction** - Server tracks sync progress per peer via `mark` mutation, enabling compaction that won't cause data loss for slow/offline clients
- **React Native support** - Native SQLite persistence via `op-sqlite` now fully works after removing Level dependencies
- **New Expo example** - Complete React Native example app with interval tracking (`examples/expo/`)
- **`mark` mutation** - Clients report sync progress to server for peer-aware compaction
- **`compact` mutation** - Manual compaction trigger with peer-aware safety (only deletes deltas all active peers have synced)
- **Recovery cursor service** - Cursor-based subscription recovery for startup reconciliation
- **SSR material prefetch** - `material` query for server-side rendering hydration
- **Type-safe compaction config** - `sizeThreshold` ("5mb") and `peerTimeout` ("24h") with human-readable strings

### Changed

- **Refactored `collection.create()` API** - Lazy-initialized, SSR-safe collection creation with deferred persistence and config resolution
- **SQLite-only persistence** - Simplified to direct SQLite storage (removed y-leveldb, abstract-level, browser-level dependencies)
- **Renamed `ack` to `mark`** - Clearer naming for peer sync progress tracking
- **Synchronous Yjs operations** - Local-first behavior with immediate Y.Doc updates
- **Moved examples from `illustrations/` to `examples/`** - Cleaner project structure

### Removed

- **Level dependencies** - Removed `y-leveldb`, `abstract-level`, `browser-level` (React Native blockers)
- **Checkpoint service** - Replaced by cursor service for seq-based sync
- **Reconciliation service** - Simplified with cursor-based approach
- **IndexedDB persistence** - Deprecated in favor of SQLite (sql.js for browser, op-sqlite for React Native)

### Fixed

- **Subscription recovery** - Use recovery cursor to prevent redundant reconciliation
- **Missing sync events** - Cursor-based protocol ensures no updates are missed (fixes `_creationTime` ordering issue)

## [1.1.1] - 2025-12-19

### Fixed

- Handle null storedDoc in SqlitePersistenceProvider - `getYDoc()` can return null for new/empty collections

## [1.1.0] - 2025-12-19

### Changed

- **Refactored API to nested object pattern** - Cleaner noun-verb API design:
  - `persistence.indexeddb()`, `persistence.sqlite.browser()`, `persistence.sqlite.native()`, `persistence.memory()`
  - `schema.table()`, `schema.prose()` (server-side)
  - `prose.extract()` (client-side text extraction)
  - `errors.*` namespace for all error classes
  - `adapters.sqljs`, `adapters.opsqlite` for SQLite adapters

### Added

- **SQLite persistence adapters** - Explicit platform choice for browser and React Native:
  - Browser: `persistence.sqlite.browser(SQL, name)` - sql.js (WASM, ~500KB) with OPFS persistence
  - React Native: `persistence.sqlite.native(db, name)` - op-sqlite (native SQLite)
  - Implements abstract-level interface with y-leveldb for Yjs persistence
- Swappable persistence layer with multiple providers:
  - `persistence.indexeddb()` - Browser using y-indexeddb and browser-level
  - `persistence.sqlite.browser()` - Browser SQLite via sql.js
  - `persistence.sqlite.native()` - React Native SQLite via op-sqlite
  - `persistence.memory()` - In-memory for testing
- `NonRetriableError` class for errors that should not be retried (auth failures, validation)
- Database name validation in SQLite persistence to prevent path traversal attacks
- Type declarations for y-leveldb module (fixes broken package.json exports)

### Changed

- Simplified prose sync architecture using TanStack DB's native `sync.sync()` callback
- SQLite persistence now uses synchronous API (consistent with other providers)
- Improved type safety in SQLite persistence (removed `any` types)
- Properly await async database operations in SQLite persistence

### Removed

- `@tanstack/offline-transactions` dependency (provided no value over native TanStack DB sync)
- `getOrInitializeCollection` helper (replaced by native TanStack DB patterns)
- Lazy loading of React Native dependencies (direct imports for better type safety)

## [1.0.0] - 2025-12-01

First stable release of Convex Replicate.

### Added

- Effect.js service architecture for dependency injection and composable services
- Comprehensive test suite with 180+ tests (unit, integration, benchmarks)
- JSDoc documentation for all exported functions
- Undo/redo and client-side history utilities
- Version history and maintenance features
- Improved type safety across client code with proper TypeScript interfaces
- Checkpoint service for managing sync checkpoints in IndexedDB
- Protocol version negotiation for handling package updates
- Snapshot recovery service for handling compaction scenarios
- Reconciliation service for phantom document cleanup

### Changed

- Refactored terminology: "sync" renamed to "replicate" throughout codebase
- Simplified architecture with cleaner Effect-based service layer
- Improved type definitions (removed `any` types in favor of proper generics)
- Streamlined Yjs update application (removed unnecessary transaction wrapper)

### Removed

- SvelteKit example (TanStack Start example remains as reference)
- Dead code and unused imports
- Outdated monorepo-style release configuration
