# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs Vite dev server and Convex backend concurrently)
bun run dev

# Individual dev processes
bun run dev:app     # Vite dev server on port 3000
bun run dev:convex  # Convex backend watcher

# Build & serve
bun run build       # Vite build + service worker generation
bun run serve       # Preview production build
```

## Environment Setup

Copy `.env.example` to `.env` and set `VITE_CONVEX_URL` to your Convex deployment URL.

## Architecture

A Linear-style issue tracker built with TanStack Router + Convex + TipTap, using `@trestleinc/replicate` for CRDT-based offline-first sync.

### Stack

- **Framework**: TanStack Router (file-based routing)
- **Editor**: TipTap (rich text with native Yjs collaboration)
- **Backend**: Convex (real-time database with WebSocket sync)
- **Sync Layer**: `@trestleinc/replicate` for CRDT-based offline-first sync
- **State**: TanStack DB + React Query for client-side reactive data
- **Persistence**: sql.js (SQLite in browser via WASM + OPFS)
- **Styling**: Tailwind CSS v4

### Key Patterns

**SQLite Persistence**: Uses sql.js instead of default IndexedDB. The `PersistenceGate` component in `IntervalsContext` blocks rendering until persistence is initialized.

**Replicate Fragments for Rich Text**: TipTap content is stored as Y.XmlFragment via Replicate's prose binding:
```typescript
const binding = await collection.utils.prose(intervalId, 'description');
const editor = useEditor({
  extensions: [
    StarterKit.configure({ history: false }),
    Collaboration.configure({ fragment: binding.fragment }),
  ],
});
```

**Singleton Collections**: `useIntervals()` and `useComments()` return module-level singletons to ensure only one sync process runs.

### File Structure

- `src/routes/` - TanStack Router file-based routes
  - `intervals/$intervalId.tsx` - Individual interval editor
  - `intervals/index.tsx` - Redirects to first interval
- `src/components/` - React components
  - `Sidebar.tsx` - Navigation, create/delete intervals
  - `IntervalEditor.tsx` - TipTap with Replicate fragment binding
  - `SearchPanel.tsx` - Cmd+K search across intervals
- `src/collections/` - Collection hooks
  - `useIntervals.ts` - Intervals collection with SQLite persistence
  - `useComments.ts` - Comments collection with SQLite persistence
- `src/contexts/IntervalsContext.tsx` - Provider with PersistenceGate
- `convex/intervals.ts` - Replicate backend (stream, material, insert, update, remove)
- `convex/schema.ts` - Schema with `schema.table()` and `schema.prose()`

### Keyboard Shortcuts

- `Cmd+K` / `Ctrl+K` - Open search panel
- `Alt+N` - Create new interval
