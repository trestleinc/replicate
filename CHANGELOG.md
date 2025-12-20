# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
