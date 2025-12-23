# Interval

A Linear-style issue tracker with offline-first sync, built as a reference implementation for [@trestleinc/replicate](https://github.com/trestleinc/replicate).

**Live Demo:** [interval.robelest.com](https://interval.robelest.com)

## What This Demonstrates

This app showcases real-world Replicate patterns beyond the basics:

- **SQLite persistence** (sql.js + OPFS) instead of default IndexedDB
- **Rich text editing** with TipTap + Yjs collaborative fragments
- **PWA with offline support** via custom Workbox service worker
- **Multiple collections** (intervals + comments) with separate persistence

## Quick Start

```bash
git clone https://github.com/robelest/interval
cd interval
bun install
cp .env.example .env
# Set VITE_CONVEX_URL to your Convex deployment
bun run dev
```

## Key Implementation Files

| Pattern | File |
|---------|------|
| SQLite Persistence Setup | [`src/collections/useIntervals.ts`](src/collections/useIntervals.ts) |
| Convex Schema | [`convex/schema.ts`](convex/schema.ts) |
| Replicate Functions | [`convex/intervals.ts`](convex/intervals.ts) |
| Rich Text Editor Binding | [`src/components/IntervalEditor.tsx`](src/components/IntervalEditor.tsx) |
| Context + PersistenceGate | [`src/contexts/IntervalsContext.tsx`](src/contexts/IntervalsContext.tsx) |
| PWA Service Worker | [`src/sw.ts`](src/sw.ts) |
| CRUD Hook | [`src/hooks/useCreateInterval.ts`](src/hooks/useCreateInterval.ts) |

## Patterns Worth Noting

### PersistenceGate

SQLite via sql.js requires async initialization. The `PersistenceGate` component blocks rendering until persistence is ready, ensuring offline-first functionality is established before any data access.

### Singleton Collections

Collections are created at module level (not inside components) to ensure only one sync process runs, even across component remounts. The `useIntervals()` hook returns the same instance every time.

### Effect-TS for Prose Binding

Rich text fields use `collection.utils.prose()` which returns a Promise. Effect-TS manages the async lifecycle with proper cancellation when switching between intervals, preventing stale bindings.

### Multi-Collection Architecture

Intervals and comments use separate SQLite databases and Replicate collections, demonstrating how to structure apps with multiple synced data types.

## Tech Stack

- **Framework:** [TanStack Router](https://tanstack.com/router) (file-based routing)
- **State:** [TanStack DB](https://tanstack.com/db) + React Query
- **Backend:** [Convex](https://convex.dev) (real-time database)
- **Sync:** [@trestleinc/replicate](https://github.com/trestleinc/replicate) (CRDT layer)
- **Editor:** [TipTap](https://tiptap.dev) + [Yjs](https://yjs.dev) (collaborative editing)
- **Offline:** [sql.js](https://sql.js.org) (SQLite in browser)
- **Styling:** Tailwind CSS v4

## Keyboard Shortcuts

- `Cmd+K` / `Ctrl+K` - Open search
- `Alt+N` - Create new interval

## Documentation

- [Replicate README](https://github.com/trestleinc/replicate#readme) - Comprehensive API reference
- [Convex Docs](https://docs.convex.dev)
- [TanStack DB Docs](https://tanstack.com/db)

## License

MIT
