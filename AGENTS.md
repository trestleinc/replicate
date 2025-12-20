# AGENTS.md - Development Guide

## Commands
- **Build:** `bun run build` (uses Rslib, outputs to `dist/`)
- **Test:** `bun test` (Vitest). Run single: `bun test src/path/to/test.ts`
- **Lint & Format:** `bun run check:fix` (Biome) - **ALWAYS RUN BEFORE COMMITTING**
- **Type Check:** Build includes type checking via Rslib

## Code Style & Conventions
- **Formatting:** 2 spaces, single quotes, semicolons (enforced by Biome).
- **Imports:** Use `import type` for types. Use `node:` protocol for Node built-ins.
- **Logging:** Use `LogTape`. Avoid `console.*` (warns in Biome, allowed in tests).
- **Structure:** Single package. `src/client` (browser), `src/server` (Convex), `src/component`.
- **Documentation:** ALWAYS use `Context7` tool for library docs (Convex, Yjs, TanStack).
- **Deletion:** Hard deletes in main table; soft deletes (append-only) in component.

## Public API

### Server (`@trestleinc/replicate/server`)
```typescript
replicate()              // Factory to create bound replicate function
table()                  // Define replicated table schema
prose()                  // Validator for prose fields
```

### Client (`@trestleinc/replicate/client`)
```typescript
convexCollectionOptions()   // Main entry point
extract()                   // Extract text from prose JSON
```

## Critical Rules (from CLAUDE.md)
- NEVER use WebSearch for library documentation; use Context7.
- Examples use `bun` and link to root via `file:../..`.
- Use `table()` helper for schemas to inject version/timestamp.
