# Sync Rules: CRDT Types API Reference

## Overview

Sync rules define how fields handle concurrent edits using **Conflict-free Replicated Data Types (CRDTs)**. Unlike Last-Write-Wins (LWW) which loses data on conflicts, CRDT types merge concurrent changes correctly without coordination.

```
User A: status = "in_progress"  (T=1000)
User B: status = "done"         (T=1001)

LWW:  B wins, A's change lost
CRDT: Both preserved, resolved via custom logic (e.g., "done" always wins)
```

---

## CRDT Types Summary

| Type | Behavior | Resolved Value | Use Case |
|------|----------|----------------|----------|
| `schema.prose()` | Character-level merge | ProseMirror JSON | Rich text content |
| `schema.counter()` | Sum all deltas | `number` | View counts, vote tallies |
| `schema.set()` | Add-wins set | `T[]` | Tags, categories, labels |
| `schema.register()` | Multi-value with custom resolution | `T` | Status fields with priority rules |

---

## Server Schema

```typescript
import { schema } from '@trestleinc/replicate/server';
import { v } from 'convex/values';

export const intervalSchema = schema.define({
  shape: v.object({
    // Standard fields (Last-Write-Wins)
    id: v.string(),
    title: v.string(),
    createdAt: v.number(),

    // CRDT: Rich text with character-level merging
    description: schema.prose(),

    // CRDT: Sum-based counter
    viewCount: schema.counter(),

    // CRDT: Add-wins set
    tags: schema.set(v.string()),

    // CRDT: Register with custom conflict resolution
    status: schema.register<StatusValue>(statusValidator, {
      resolve: (conflict) => {
        // Higher priority status wins
        const priority = { done: 4, in_progress: 3, todo: 2, backlog: 1, canceled: 0 };
        return conflict.values.sort((a, b) => priority[b] - priority[a])[0];
      },
    }),

    // CRDT: Register with default resolution (latest by timestamp)
    priority: schema.register<PriorityValue>(priorityValidator),
  }),

  defaults: {
    status: 'backlog',
    priority: 'none',
    tags: [],
    viewCount: 0,
  },
});
```

---

## Client Bindings API

### Prose (Rich Text)

Character-level merging for collaborative rich text editing.

```typescript
const binding = await collection.utils.prose(documentId, 'description', {
  debounceMs: 300,   // Sync debounce (default: 200)
  throttleMs: 300,   // Sync throttle
});

// TipTap integration
const editor = new Editor({
  extensions: [
    StarterKit.configure({ history: false }),
    Collaboration.configure({ fragment: binding.fragment }),
    CollaborationCaret.configure({ provider: binding.provider }),
  ],
});

// Cleanup
binding.destroy();
```

**Interface:**
```typescript
interface EditorBinding {
  fragment: Y.XmlFragment;           // Yjs fragment for editor
  provider: { awareness: Awareness }; // Presence/cursor provider
  destroy(): void;
}
```

---

### Counter

Sum-based counter that never loses increments from concurrent edits.

```typescript
const counter = await collection.utils.counter(documentId, 'viewCount');

// Read
counter.value();        // Get current sum: number

// Mutate
counter.increment(1);   // Add to counter
counter.decrement(5);   // Subtract from counter

// Subscribe to changes
const unsubscribe = counter.subscribe((value) => {
  console.log('Count:', value);
});

// Cleanup
counter.destroy();
```

**Interface:**
```typescript
interface CounterBinding {
  value(): number;
  increment(delta?: number): void;  // default: 1
  decrement(delta?: number): void;  // default: 1
  subscribe(callback: (value: number) => void): () => void;
  destroy(): void;
}
```

---

### Set (Add-Wins)

Add-wins set where concurrent adds are unioned. Remove only wins if it happened after the add.

```typescript
const set = await collection.utils.set<string>(documentId, 'tags', {
  serialize: (item) => item,      // Convert item to string key
  deserialize: (key) => key,      // Convert key back to item
});

// Read
set.values();           // Get all items: T[]
set.has('urgent');      // Check membership: boolean

// Mutate
set.add('urgent');      // Add item
set.remove('urgent');   // Remove item

// Subscribe to changes
const unsubscribe = set.subscribe((values) => {
  console.log('Tags:', values);
});

// Cleanup
set.destroy();
```

**Add-Wins Semantics:**
```
Tab A: add('x')         Tab B: remove('x')    (concurrent)
Result: 'x' is present  (add wins)

Tab A: add('x')         Tab B: remove('x')    (B after A)
Result: 'x' is removed  (remove wins when causal)
```

**Interface:**
```typescript
interface SetBinding<T> {
  values(): T[];
  has(item: T): boolean;
  add(item: T): void;
  remove(item: T): void;
  subscribe(callback: (values: T[]) => void): () => void;
  destroy(): void;
}
```

**For objects:**
```typescript
const set = await collection.utils.set<User>(documentId, 'assignees', {
  serialize: (user) => JSON.stringify(user),
  deserialize: (key) => JSON.parse(key) as User,
});
```

---

### Register (Multi-Value with Conflict Resolution)

Multi-value register where each client's value is preserved until resolved. Supports custom conflict resolution.

```typescript
const register = await collection.utils.register<StatusValue>(documentId, 'status');

// Read
register.value();        // Resolved value using schema resolver: T
register.values();       // All concurrent values: T[]
register.hasConflict();  // Multiple values exist?: boolean
register.conflict();     // Conflict info or null

// Mutate
register.set('done');    // Set value for current client

// Subscribe to changes
const unsubscribe = register.subscribe((value, conflict) => {
  console.log('Status:', value);
  if (conflict) {
    console.log('Resolved from:', conflict.values);
  }
});

// Cleanup
register.destroy();
```

**Interface:**
```typescript
interface RegisterBinding<T> {
  value(): T;                    // Resolved value
  values(): T[];                 // All concurrent values
  hasConflict(): boolean;
  conflict(): Conflict<T> | null;
  set(value: T): void;
  subscribe(callback: (value: T, conflict: Conflict<T> | null) => void): () => void;
  destroy(): void;
}

interface Conflict<T> {
  values: T[];                   // All concurrent values
  entries: Array<{
    value: T;
    clientId: string;
    timestamp: number;
  }>;
  latest(): T;                   // Helper: latest by timestamp
  byClient(id: string): T | undefined;
}
```

**Conflict Resolution:**
```typescript
// Schema-defined resolver (recommended)
schema.register<Status>(validator, {
  resolve: (conflict) => {
    // Custom logic: "done" always wins
    if (conflict.values.includes('done')) return 'done';
    return conflict.latest();
  },
});

// Default resolver (when no resolve provided)
// Uses latest by timestamp
schema.register<string>(validator);  // → conflict.latest()
```

---

## Usage Pattern (Svelte 5)

```svelte
<script lang="ts">
  import { browser } from '$app/environment';
  import type { CounterBinding, SetBinding, RegisterBinding } from '@trestleinc/replicate/client';

  let { documentId } = $props();
  const ctx = getCollectionContext();

  // State
  let counter = $state<CounterBinding | null>(null);
  let viewCount = $state(0);

  let tagsBinding = $state<SetBinding<string> | null>(null);
  let tags = $state<string[]>([]);

  let statusBinding = $state<RegisterBinding<Status> | null>(null);
  let status = $state<Status>('backlog');

  // Initialize bindings
  $effect(() => {
    if (!browser) return;

    const init = async () => {
      // Counter
      counter = await ctx.collection.utils.counter(documentId, 'viewCount');
      counter.subscribe((v) => { viewCount = v; });
      counter.increment(1);  // Track page view

      // Set
      tagsBinding = await ctx.collection.utils.set<string>(documentId, 'tags', {
        serialize: (item) => item,
        deserialize: (key) => key,
      });
      tagsBinding.subscribe((v) => { tags = v; });

      // Register
      statusBinding = await ctx.collection.utils.register<Status>(documentId, 'status');
      statusBinding.subscribe((v) => { status = v; });
    };

    init();

    return () => {
      counter?.destroy();
      tagsBinding?.destroy();
      statusBinding?.destroy();
    };
  });

  // Handlers
  function addTag(tag: string) {
    tagsBinding?.add(tag.trim().toLowerCase());
  }

  function removeTag(tag: string) {
    tagsBinding?.remove(tag);
  }

  function setStatus(newStatus: Status) {
    statusBinding?.set(newStatus);
  }
</script>
```

---

## Important Notes

### CRDT fields are skipped by `collection.update()`

```typescript
// ❌ BROKEN - CRDT fields are intentionally skipped
collection.update(id, (draft) => {
  draft.tags = [...draft.tags, 'new'];     // Ignored!
  draft.status = 'done';                    // Ignored!
  draft.viewCount = draft.viewCount + 1;   // Ignored!
});

// ✅ CORRECT - Use dedicated bindings
tagsBinding.add('new');
statusBinding.set('done');
counterBinding.increment(1);
```

### Regular fields still use `collection.update()`

```typescript
// ✅ Non-CRDT fields work normally
collection.update(id, (draft) => {
  draft.title = 'New Title';      // Works
  draft.updatedAt = Date.now();   // Works
});
```

### Bindings require `await` and cleanup

```typescript
// Always await binding creation
const binding = await collection.utils.counter(id, 'field');

// Always cleanup on unmount
return () => {
  binding.destroy();
};
```

---

## Exports

```typescript
// Client
import {
  collection,
  type EditorBinding,
  type CounterBinding,
  type SetBinding,
  type RegisterBinding,
} from '@trestleinc/replicate/client';

// Server
import { schema } from '@trestleinc/replicate/server';

schema.prose();
schema.counter();
schema.set(validator);
schema.register(validator, { resolve? });
```
