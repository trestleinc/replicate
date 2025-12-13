# Prose API Migration Guide

## Overview

Refactoring the `@trestleinc/replicate` library to provide a cleaner, type-safe API for integrating collaborative rich text editors (BlockNote/TipTap) with Convex + Yjs. This eliminates inconsistent/deprecated APIs and aligns with TanStack DB patterns.

---

## Progress Tracker

### Phase 1: Core Library Changes

| # | Task | File | Status |
|---|------|------|--------|
| 1 | Add `ProseFields<T>` utility type | `src/shared/types.ts` | ✅ Done |
| 2 | Rename `FragmentNotFoundError` → `ProseFieldNotFoundError` | `src/client/errors.ts` | ✅ Done |
| 3 | Add `prose()` validator helper | `src/server/schema.ts` | ✅ Done |
| 4 | Export `prose` from server | `src/server/index.ts` | ✅ Done |
| 5 | Remove deprecated merge helpers | `src/client/merge.ts` | ✅ Done |
| 6 | Refactor collection API | `src/client/collection.ts` | ✅ Done |
| 7 | Update client exports | `src/client/index.ts` | ✅ Done |

### Phase 2: Test Updates

| # | Task | File | Status |
|---|------|------|--------|
| 8 | Refactor tests for new API | `src/test/integration/fragment.test.ts` | ✅ Done |
| 9 | Update tests for `isProseMirrorDoc` | `src/test/unit/xmlfragment.test.ts` | ✅ Done |
| 10 | Verify merge tests still pass | `src/test/unit/merge.test.ts` | ✅ Done |
| 11 | Update conflict tests | `src/test/integration/conflict.test.ts` | ✅ Done |

### Phase 3: Validation

| # | Task | Command | Status |
|---|------|---------|--------|
| 12 | Build passes | `pnpm run build` | ✅ Done |
| 13 | Lint/format passes | `pnpm run check:fix` | ✅ Done |
| 14 | Tests pass (80/80) | `pnpm test` | ✅ Done |

### Phase 4: Notebook Example Updates (TODO)

| # | Task | File | Status |
|---|------|------|--------|
| 15 | Use `prose()` validator in schema | `notebook/convex/schema.ts` | ⬜ Pending |
| 16 | Verify `XmlFragmentJSON` type usage | `notebook/src/types/notebook.ts` | ⬜ Pending |
| 17 | Remove `handleReconnect`, add `prose: ['content']` | `notebook/src/collections/useNotebooks.ts` | ⬜ Pending |
| 18 | Remove `fragment()` usage, use plain JSON | `notebook/src/components/Sidebar.tsx` | ⬜ Pending |
| 19 | Change to `collection.utils.prose()` with Promise | `notebook/src/components/NotebookEditor.tsx` | ⬜ Pending |

---

## API Changes Summary

### Removed Exports

From `src/client/index.ts`:
- `handleReconnect` - merged into internal `initializeCollectionWithOffline()`
- `getYDoc` - internal implementation detail
- `fragment` - no longer needed, use plain JSON
- `extractItemWithFragments` - removed
- `extractItemsWithFragments` - removed
- `FragmentNotFoundError` - renamed to `ProseFieldNotFoundError`

From `src/client/merge.ts`:
- `fragment()` helper function
- `extractItemWithFragments()`
- `extractItemsWithFragments()`
- `isFragment()` replaced with `isProseMirrorDoc()` for auto-detection

### New Exports

From `src/client/index.ts`:
- `ProseFieldNotFoundError` - renamed from `FragmentNotFoundError`
- `ConvexCollectionUtils` - interface with `prose()` method
- `getOrInitializeCollection` - lazy initialization helper

From `src/server/index.ts`:
- `prose` - validator helper for schema definitions

From `src/shared/types.ts`:
- `ProseFields<T>` - utility type for extracting prose field names

### Collection API Changes

**Before:**
```typescript
// Schema
notebooks: replicatedTable({ content: v.any() });

// Insert with fragment wrapper
collection.insert({ content: fragment({ type: 'doc', content: [...] }) });

// Editor binding with Effect
const binding = yield* collection.editor(id, 'content');

// Reconnect handling
const collection = handleReconnect(createCollection(...));
```

**After:**
```typescript
// Schema with prose() validator
import { prose, replicatedTable } from '@trestleinc/replicate/server';
notebooks: replicatedTable({ content: prose() });

// Insert with plain JSON (auto-detected via prose config)
collection.insert({ content: { type: 'doc', content: [...] } });

// Editor binding with Promise on utils
const binding = await collection.utils.prose(id, 'content');

// Reconnect handling built-in via prose config
const collection = createCollection(
  convexCollectionOptions<Notebook>({
    prose: ['content'],  // Type-safe field names
    // ...other config
  })
);
```

---

## Detailed Changes by File

### `src/shared/types.ts`
Added `ProseFields<T>` utility type that extracts field names where the value type is `XmlFragmentJSON`.

### `src/client/errors.ts`
Renamed `FragmentNotFoundError` → `ProseFieldNotFoundError`.

### `src/server/schema.ts`
Added `prose()` validator helper for schema definitions.

### `src/server/index.ts`
Exported `prose` from schema.

### `src/client/merge.ts`
- Removed `fragment()` helper function
- Removed `extractItemWithFragments()`
- Removed `extractItemsWithFragments()`
- Replaced `isFragment()` with `isProseMirrorDoc()` for auto-detection

### `src/client/collection.ts`
- Added `prose: Array<ProseFields<T>>` to `ConvexCollectionOptionsConfig`
- Created `ConvexCollectionUtils<T>` interface with `prose()` method
- Simplified `ConvexCollection<T>` to just have `utils` property
- Merged `handleReconnect` logic into `initializeCollectionWithOffline()` internal function
- Created `getOrInitializeCollection()` for lazy initialization
- Removed deprecated methods: `fragment()`, `editor()`, `undo()`, `redo()`, `canUndo()`, `canRedo()`, `syncContent()`
- Removed `getYDoc()` export
- Updated `applyYjsInsert`/`applyYjsUpdate` to use prose config for auto-detection

### `src/client/index.ts`
Updated exports:
- Removed: `handleReconnect`, `getYDoc`, `fragment`, `extractItemWithFragments`, `extractItemsWithFragments`, `FragmentNotFoundError`
- Added: `ProseFieldNotFoundError`, `ConvexCollectionUtils`, `getOrInitializeCollection`

---

## Notes

- The `notebook/` example directory still needs to be updated to use the new API
- All core library tests pass (80/80)
- Build and lint checks pass
- Always run `pnpm run check:fix` before committing
