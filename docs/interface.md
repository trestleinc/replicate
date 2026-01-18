# Replicate API Interface Design

This document captures the design constraints and tradeoffs for replicate's server-side API pattern.

## Current Pattern: Flat Exports with Destructuring

```typescript
// convex/intervals.ts
export const {
  stream, material, insert, update, remove,
  recovery, mark, compact, sessions, presence,
} = collection.create<Interval>(components.replicate, "intervals", {
  hooks: {
    evalRead: (ctx) => authorize(ctx),
    evalWrite: (ctx, doc) => validate(doc),
  }
});
```

### Why This Pattern Exists

1. **Convex requires flat, static ESM exports** - Convex function files must export functions at the top level. Nested objects like `export const rp = { stream: ..., sessions: { query: ... } }` don't work because Convex can't recognize nested properties as callable functions.

2. **Hooks require function generation** - Unlike bridge where component functions are used directly, replicate needs to wrap component functions with user-specific hooks (auth, validation, transforms). This generates new functions that must be exported.

3. **Client library uses these internally** - The replicate client library calls `api.stream`, `api.insert`, etc. internally. Users only call `material` directly for SSR.

## Comparison: Bridge Pattern

Bridge uses a different pattern that avoids destructuring:

```typescript
// Bridge: convex/bridge.ts
const b = bridge(components.bridge)({
  hooks: { read: authCheck }
});

// Access via nested object
b.api.card.get      // -> components.bridge.public.cardGet
b.api.procedure.submit
```

### Why Bridge Works Differently

1. **Component exports are the final product** - Bridge's component (`src/component/public.ts`) exports ready-to-use functions (`cardGet`, `procedureSubmit`). The builder just provides nicer access to them.

2. **No per-function hooks on core CRUD** - Bridge's hooks are on high-level operations (`submit`, `evaluate`), not on every function. Core functions like `cardGet` have no hooks.

3. **Users call via ctx.runQuery** - Bridge functions are called server-side via `ctx.runQuery(b.api.card.get, ...)`, not directly from clients.

### Key Difference

| Aspect              | Bridge                                   | Replicate                     |
| ------------------- | ---------------------------------------- | ----------------------------- |
| Component exports   | Final functions (cardGet, etc.)          | Internal functions            |
| Function generation | None - uses component functions directly | Wraps with hooks              |
| User exports        | None needed                              | Required for Convex           |
| Hooks               | On high-level operations only            | On every function             |
| Client access       | Indirect (via user's wrapper functions)  | Direct (api.intervals.stream) |

## Constraints

### Convex ESM Limitation

Convex generates API types based on static exports from function files:

```typescript
// This works - Convex sees 'stream' as a function
export const stream = query({...});

// This doesn't work - Convex can't see nested functions
export const rp = {
  stream: query({...}),
  sessions: query({...}),
  presence: mutation({...}),
};
```

### Hooks Requirement

Replicate needs hooks on core functions for:

- **evalRead** - Authorization before read operations
- **evalWrite** - Authorization/validation before writes
- **evalRemove** - Authorization before deletes
- **transform** - Modify documents before returning

These hooks contain user-specific logic that the component can't know ahead of time.

## Potential Future Options

### Option 1: Keep Current (Recommended for Now)

Flat exports with destructuring. Verbose but works.

```typescript
export const {
  stream, material, insert, update, remove,
  recovery, mark, compact, sessions, presence,
} = collection.create<Interval>(components.replicate, "intervals");
```

### Option 2: Bridge-Style (No Hooks on Core Functions)

Move to bridge pattern where component exports base functions directly. Users write wrapper functions for auth.

```typescript
const rp = replicate(components.replicate)({ collection: "intervals" });

// Only export what's needed for SSR
export const material = rp.api.material;

// Client uses rp.api internally, no exports needed
// But user must handle auth in their own wrapper functions
```

**Tradeoff**: Cleaner exports, but lose built-in hooks. More boilerplate for auth.

### Option 3: Nested Object with Spread Helper

Provide a helper to flatten nested structure for export:

```typescript
const rp = collection.create<Interval>(...);

// rp has nested structure for related functions
// flatten() converts to flat exports
export const { stream, material, sessions, presence, ... } = flatten(rp);
```

**Tradeoff**: Still need destructuring, just with slightly better internal organization.

### Option 4: Middleware/Context System

Pass hooks via server-side context instead of at function creation:

```typescript
// Component exports generic functions
// Hooks applied via middleware at request time
export const stream = withHooks(component.stream, { evalRead: authorize });
```

**Tradeoff**: Complex implementation, unclear DX benefits.

## Current API Structure

### Server Exports (from collection.create)

| Export     | Type     | Purpose                              |
| ---------- | -------- | ------------------------------------ |
| `stream`   | query    | Real-time CRDT stream (cursor-based) |
| `material` | query    | SSR hydration                        |
| `recovery` | query    | State vector sync                    |
| `insert`   | mutation | Insert document                      |
| `update`   | mutation | Update document                      |
| `remove`   | mutation | Delete document                      |
| `mark`     | mutation | Peer sync tracking                   |
| `compact`  | mutation | Manual compaction                    |
| `sessions` | query    | Connected sessions (presence)        |
| `cursors`  | query    | Cursor positions                     |
| `leave`    | mutation | Explicit disconnect                  |

### Client Usage

The client library receives the API object and calls these internally:

```typescript
// Client collection config
config: () => ({
  api: api.intervals,  // { stream, insert, sessions, leave, ... }
  ...
})
```

The client library handles subscriptions, mutations, and presence sync using these function references.

### SSR Usage

Users call `material` directly for server-side rendering:

```typescript
// Server loader
const material = await httpClient.query(api.intervals.material);
return { material };

// Client hydration
await intervals.init(material);
```

## Decision Log

- **2024-12-30**: Explored nested `rp` export pattern. Reverted because Convex can't recognize nested objects as callable functions. Documented tradeoffs in this file.

## Future Consideration: Rename for Clarity

Consider renaming session-related exports for clarity:

- `sessions` → keep (presence query)
- `cursors` → keep (cursor positions)
- `leave` → `sessionsLeave` or `disconnect` (explicit disconnect)

This groups related functionality by naming convention even with flat exports.
