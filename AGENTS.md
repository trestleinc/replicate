# AGENTS.md - Development Guide

## Commands
- **Build:** `bun run build` (uses tsdown, outputs to `dist/`)
- **Test:** `bun run test` (Vitest). Run single: `bun test src/path/to/test.ts`
- **Lint & Format:** `bun run lint:fix` (ESLint + Stylistic) - **ALWAYS RUN BEFORE COMMITTING**
- **Type Check:** Build includes type checking via tsdown

## Code Style & Conventions
- **Formatting:** 2 spaces, double quotes, semicolons (enforced by ESLint Stylistic).
- **Imports:** Use `import type` for types. Use `node:` protocol for Node built-ins.
- **Logging:** Use `LogTape`. Avoid `console.*` (warns in ESLint, allowed in tests).
- **Structure:** Single package. `src/client` (browser), `src/server` (Convex), `src/component`.
- **Documentation:** ALWAYS use `Context7` tool for library docs (Convex, Yjs, TanStack).
- **Deletion:** Hard deletes in main table; soft deletes (append-only) in component.

## Public API

### Server (`@trestleinc/replicate/server`)
```typescript
replicate()              // Factory to create bound replicate function
schema.table()           // Define replicated table schema (injects timestamp)
schema.prose()           // Validator for prose fields
```

### Client (`@trestleinc/replicate/client`)
```typescript
collection.create()          // Main entry point - create lazy-initialized collections
persistence.sqlite.browser() // Browser SQLite persistence (sql.js + OPFS)
persistence.sqlite.native()  // React Native SQLite persistence (op-sqlite)
persistence.memory()         // In-memory persistence (testing)
persistence.custom()         // Custom storage adapter
prose()                      // Zod schema for prose fields
prose.extract()              // Extract plain text from prose JSON
prose.empty()                // Create empty prose value
errors.*                     // Error classes (Network, IDB, Prose, etc.)
```

## Critical Rules (from CLAUDE.md)
- NEVER use WebSearch for library documentation; use Context7.
- Examples use `bun` and link to root via `file:../..`.
- Use `table()` helper for schemas to inject version/timestamp.
