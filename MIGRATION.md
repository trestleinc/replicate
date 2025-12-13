# API Migration Guide

## Overview

The `@trestleinc/replicate` library has been refactored for a cleaner, slimmer API surface with single-word naming conventions following TanStack DB patterns.

---

## Breaking Changes

### Server API Renames

| Before | After |
|--------|-------|
| `defineReplicate()` | `define()` |
| `replicatedTable()` | `table()` |

```typescript
// Before
import { defineReplicate, replicatedTable, prose } from '@trestleinc/replicate/server';

export const { stream, insert, update, remove } = defineReplicate<Task>({ ... });
export default defineSchema({ tasks: replicatedTable({ ... }) });

// After
import { define, table, prose } from '@trestleinc/replicate/server';

export const { stream, insert, update, remove } = define<Task>({ ... });
export default defineSchema({ tasks: table({ ... }) });
```

### Client API Renames

| Before | After |
|--------|-------|
| `fragmentToText()` | `extract()` |
| `ProseFieldNotFoundError` | `ProseError` |

```typescript
// Before
import { fragmentToText, ProseFieldNotFoundError } from '@trestleinc/replicate/client';

// After
import { extract, ProseError } from '@trestleinc/replicate/client';
```

### Removed Exports

The following are no longer exported (use direct imports if needed):

| Export | Replacement |
|--------|-------------|
| `setReplicate()` | Auto-called internally |
| `getProtocolInfo()` | `collection.utils.protocol()` |
| `getOrInitializeCollection()` | Internal helper |
| `YjsOrigin` | Import from `yjs` if needed |
| `IndexeddbPersistence` | Import from `y-indexeddb` |
| `NonRetriableError` | Import from `@tanstack/offline-transactions` |
| Type exports | TypeScript infers these |

### New Utils Method

Protocol info is now accessible via `collection.utils.protocol()`:

```typescript
// Before
import { getProtocolInfo } from '@trestleinc/replicate/client';
const info = await getProtocolInfo(convexClient, { protocol: api.protocol });

// After
const info = await collection.utils.protocol();
// Returns: { serverVersion, localVersion, needsMigration }
```

---

## Final Public API

### Client (`@trestleinc/replicate/client`)

```typescript
// Functions
convexCollectionOptions()   // main entry point
extract()                   // extract text from prose JSON

// Errors (Effect TaggedErrors)
NetworkError
IDBError
IDBWriteError
ReconciliationError
ProseError
CollectionNotReadyError

// Methods on collection.utils
collection.utils.prose(id, field)    // returns EditorBinding
collection.utils.protocol()          // returns ProtocolInfo
```

### Server (`@trestleinc/replicate/server`)

```typescript
define()    // define replicate handlers
table()     // define replicated table schema
prose()     // validator for prose fields
```

---

## Usage Example

```typescript
// convex/schema.ts
import { defineSchema } from 'convex/server';
import { table, prose } from '@trestleinc/replicate/server';
import { v } from 'convex/values';

export default defineSchema({
  notebooks: table({
    id: v.string(),
    title: v.string(),
    content: prose(),
  }),
});

// convex/notebooks.ts
import { define } from '@trestleinc/replicate/server';

export const { stream, insert, update, remove, protocol } = define<Notebook>({
  component: components.replicate,
  collection: 'notebooks',
});

// client code
import { convexCollectionOptions, extract, ProseError } from '@trestleinc/replicate/client';

const collection = createCollection(
  convexCollectionOptions<Notebook>({
    convexClient,
    api: api.notebooks,
    collection: 'notebooks',
    prose: ['content'],
    getKey: (n) => n.id,
  })
);

// Get editor binding
const binding = await collection.utils.prose(id, 'content');

// Extract text for search
const text = extract(notebook.content);

// Check protocol version
const { needsMigration } = await collection.utils.protocol();
```
