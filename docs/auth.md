# Authentication & Authorization

This guide explains how to secure your Replicate collections.

## Overview

Replicate uses a layered auth model:

```
view     = read access gate (documents, sync, presence)
hooks    = write access gate + lifecycle events
```

The `view` function controls **all read access**. If a user can't see a document via `view`, they also can't:
- Fetch it via `material`
- Sync it via `delta`
- See who's editing it via `session`
- Join presence for it via `presence`

```typescript
collection.create<Task>(components.replicate, "tasks", {
  // Read access: controls what documents user can see + join
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    
    return q
      .withIndex("by_owner", q => q.eq("ownerId", identity.subject))
      .order("desc");
  },
  
  // Write access: additional validation for mutations
  hooks: {
    evalWrite: async (ctx, doc) => { /* validate writes */ },
    evalRemove: async (ctx, docId) => { /* validate deletes */ },
  },
});
```

## API Auth Matrix

| API | Type | Auth | Purpose |
|-----|------|------|---------|
| `material` | query | `view` | SSR hydration, paginated docs |
| `delta` | query | `view` | Real-time sync stream |
| `session` | query | `view` | Who's online (user-level) |
| `presence` | mutation | `view` | Join/leave/heartbeat |
| `replicate` | mutation | `evalWrite` / `evalRemove` | Insert/update/delete |

**Key insight**: `view` gates everything. If you can't read a document, you can't interact with it at all.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CONFIGURATION                                  │
└─────────────────────────────────────────────────────────────────────────────┘

  collection.create<Task>(components.replicate, "tasks", {
    
    ┌─────────────────────────────────────────────────────────────────────┐
    │  view: async (ctx, q) => { ... }           ◄── READ ACCESS GATE     │
    │                                                                     │
    │  - Throw to deny ALL access (read + presence)                       │
    │  - Return filtered query to limit visible documents                 │
    │  - Applied to: material, delta, session, presence                   │
    └─────────────────────────────────────────────────────────────────────┘
    
    ┌─────────────────────────────────────────────────────────────────────┐
    │  hooks: {                                  ◄── WRITE ACCESS + EVENTS│
    │    evalWrite:   (ctx, doc) => { ... }      // validate writes       │
    │    evalRemove:  (ctx, docId) => { ... }    // validate deletes      │
    │    evalSession: (ctx, client) => { ... }   // additional presence   │
    │    transform:   (docs) => { ... }          // field filtering       │
    │    onInsert/onUpdate/onRemove              // lifecycle events      │
    │  }                                                                  │
    └─────────────────────────────────────────────────────────────────────┘
  })

┌─────────────────────────────────────────────────────────────────────────────┐
│                                 API LAYER                                   │
└─────────────────────────────────────────────────────────────────────────────┘

         QUERIES (read)                           MUTATIONS (write)
         
  ┌──────────────────────┐                 ┌──────────────────────┐
  │      material        │                 │      replicate       │
  │  └─► view ✓          │                 │  └─► evalWrite ✓     │
  │  └─► transform ✓     │                 │  └─► evalRemove ✓    │
  └──────────────────────┘                 └──────────────────────┘
  
  ┌──────────────────────┐                 ┌──────────────────────┐
  │       delta          │                 │      presence        │
  │  └─► view ✓          │                 │  └─► view ✓          │
  └──────────────────────┘                 │  └─► evalSession ✓   │
                                           └──────────────────────┘
  ┌──────────────────────┐
  │      session         │
  │  └─► view ✓          │
  │  └─► groups by user  │
  └──────────────────────┘
```

## View Function

The `view` function is the single entry point for read authorization:

```typescript
type ViewFunction = (
  ctx: QueryCtx,
  query: Query<TableInfo>
) => OrderedQuery<TableInfo> | Promise<OrderedQuery<TableInfo>>;
```

It does three things:
1. **Auth check** - Throw to deny access entirely
2. **Filtering** - Use `.withIndex()` to limit visible documents  
3. **Ordering** - Chain `.order("asc" | "desc")`

### How View Applies to Each API

**`material` query:**
```
view() → filtered query → paginate → transform → return docs
```

**`delta` query:**
```
view() → for each delta, check if doc is in view → return visible deltas
```

**`session` query:**
```
view() → verify user can access document → return presence (grouped by user)
```

**`presence` mutation:**
```
view() → verify user can access document → allow join/leave
```

## Hooks

Hooks provide write-side authorization and lifecycle events:

```typescript
hooks: {
  // Write authorization (throw to deny)
  evalWrite?: (ctx: MutationCtx, doc: T) => void | Promise<void>;
  evalRemove?: (ctx: MutationCtx, docId: string) => void | Promise<void>;
  evalSession?: (ctx: MutationCtx, client: string) => void | Promise<void>;
  
  // Lifecycle events (run after operation)
  onInsert?: (ctx: MutationCtx, doc: T) => void | Promise<void>;
  onUpdate?: (ctx: MutationCtx, doc: T) => void | Promise<void>;
  onRemove?: (ctx: MutationCtx, docId: string) => void | Promise<void>;
  
  // Field-level transform (runs on query results)
  transform?: (docs: T[]) => T[] | Promise<T[]>;
}
```

### View vs Hooks

| Concern | Use `view` | Use `hooks` |
|---------|-----------|-------------|
| "Can user read this?" | ✅ | |
| "Can user see who's editing?" | ✅ | |
| "Can user join presence?" | ✅ | |
| "Can user write this?" | | ✅ `evalWrite` |
| "Can user delete this?" | | ✅ `evalRemove` |
| "Hide sensitive fields" | | ✅ `transform` |
| "Log after write" | | ✅ `onInsert` etc |

## Session + Presence

### Session Query (Who's Online)

The `session` query returns user-level presence, grouped from device-level sessions:

```
Sessions Table (device-level)              session query output (user-level)

┌─────────────────────────────┐           ┌─────────────────────────────┐
│ client: "device-aaa"        │──┐        │                             │
│ user: "alice"               │  │        │  user: "alice"              │
│ cursor: { pos: 10 }         │  ├──────► │  cursor: { pos: 42 }        │
│ seen: 1000                  │  │        │  profile: { name: "Alice" } │
├─────────────────────────────┤  │        │                             │
│ client: "device-bbb"        │──┘        └─────────────────────────────┘
│ user: "alice"               │ (grouped, most recent cursor wins)
│ cursor: { pos: 42 }         │
│ seen: 2000 ◄─── latest      │           ┌─────────────────────────────┐
├─────────────────────────────┤           │                             │
│ client: "device-ccc"        │──────────►│  user: "bob"                │
│ user: "bob"                 │           │  cursor: { pos: 5 }         │
│ cursor: { pos: 5 }          │           │  profile: { name: "Bob" }   │
└─────────────────────────────┘           │                             │
                                          └─────────────────────────────┘
```

**Auth flow:**
1. `view()` runs - checks if user can access the document
2. If authorized, query sessions for that document
3. Group by user, return most recent session per user

### Presence Mutation (Join/Leave)

The `presence` mutation lets users join/leave a document's presence:

```typescript
// Client calls presence to join
await convex.mutation(api.tasks.presence, {
  action: "join",
  document: "doc123",
  client: deviceId,           // Unique per device/tab
  user: identity.subject,     // From auth provider
  profile: { name: "Alice", color: "#6366f1" },
  cursor: { anchor: 0, head: 0 },
});
```

**Auth flow:**
1. `view()` runs - checks if user can access the document
2. If authorized, `evalSession()` runs for additional validation
3. Session record created/updated in sessions table

### Identity Flow

```
Auth Provider          Client                  presence mutation       sessions table
     │                   │                           │                      │
     │  JWT              │                           │                      │
     ├──────────────────►│                           │                      │
     │                   │                           │                      │
     │            identity.subject                   │                      │
     │            = "user:alice"                     │                      │
     │                   │                           │                      │
     │                   │  presence({               │                      │
     │                   │    action: "join",        │                      │
     │                   │    document: "doc123",    │                      │
     │                   │    client: "device-uuid", │                      │
     │                   │    user: identity.subject,│ ◄── USER ID FROM AUTH│
     │                   │    profile: {...},        │                      │
     │                   │  })                       │                      │
     │                   │─────────────────────────► │                      │
     │                   │                           │                      │
     │                   │                    view() │ ◄── CAN USER SEE DOC?│
     │                   │                           │                      │
     │                   │               evalSession │ ◄── EXTRA VALIDATION │
     │                   │                           │                      │
     │                   │                           │  INSERT/UPDATE ─────►│
```

## Usage Patterns

### Pattern 1: User-Owned Data

```typescript
collection.create<Task>(components.replicate, "tasks", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    
    return q
      .withIndex("by_owner", q => q.eq("ownerId", identity.subject))
      .order("desc");
  },
  
  hooks: {
    evalWrite: async (ctx, doc) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
      if (doc.ownerId !== identity.subject) {
        throw new Error("Forbidden: cannot modify other users' data");
      }
    },
  },
});
```

### Pattern 2: Multi-Tenant (Organization)

```typescript
collection.create<Project>(components.replicate, "projects", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.org_id) {
      throw new Error("Unauthorized: must belong to organization");
    }
    
    return q
      .withIndex("by_tenant", q => q.eq("tenantId", identity.org_id))
      .order("desc");
  },
});
```

### Pattern 3: Role-Based Access

```typescript
collection.create<Document>(components.replicate, "documents", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", q => q.eq("tokenIdentifier", identity.subject))
      .unique();
    
    // Admins see all, others see only their own
    if (user?.role === "admin") {
      return q.withIndex("by_timestamp").order("desc");
    }
    
    return q
      .withIndex("by_owner", q => q.eq("ownerId", identity.subject))
      .order("desc");
  },
});
```

### Pattern 4: Public Collection (No Auth)

```typescript
collection.create<Post>(components.replicate, "publicPosts", {
  // No view = all documents visible, anyone can read + see presence
  
  hooks: {
    // But still protect writes
    evalWrite: async (ctx, doc) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
    },
  },
});
```

### Pattern 5: Field-Level Security

```typescript
collection.create<User>(components.replicate, "users", {
  view: async (ctx, q) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    
    return q
      .withIndex("by_tenant", q => q.eq("tenantId", identity.org_id))
      .order("desc");
  },
  
  hooks: {
    // Remove sensitive fields before sending to client
    transform: (docs) => docs.map(doc => ({
      ...doc,
      passwordHash: undefined,
      internalNotes: undefined,
    })),
  },
});
```

## Schema Requirements

Your schema must include indexes that match your `view` queries:

```typescript
// convex/schema.ts
import { defineSchema } from "convex/server";
import { v } from "convex/values";
import { schema } from "@trestleinc/replicate/server";

export default defineSchema({
  tasks: schema.table({
    ownerId: v.string(),
    tenantId: v.optional(v.string()),
    title: v.string(),
    status: v.string(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_tenant", ["tenantId"])
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_doc_id", ["id"])
    .index("by_timestamp", ["timestamp"]),
});
```

## Security Best Practices

### 1. Always Use Indexes in View

```typescript
// GOOD - Uses index, efficient O(log n)
view: async (ctx, q) => {
  const identity = await ctx.auth.getUserIdentity();
  return q
    .withIndex("by_owner", q => q.eq("ownerId", identity?.subject))
    .order("desc");
},

// BAD - Full table scan, then filter O(n)
hooks: {
  transform: (docs) => docs.filter(d => d.ownerId === userId),
},
```

### 2. Validate Writes Separately

`view` controls reads, but writes need explicit validation:

```typescript
hooks: {
  evalWrite: async (ctx, doc) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    
    // Verify ownership
    if (doc.ownerId !== identity.subject) {
      throw new Error("Forbidden");
    }
  },
},
```

### 3. Don't Trust Client Data

```typescript
hooks: {
  evalWrite: async (ctx, doc) => {
    const identity = await ctx.auth.getUserIdentity();
    // Override ownerId with authenticated user
    doc.ownerId = identity!.subject;
  },
},
```

### 4. Use View for Presence Auth

If a user shouldn't see a document, they shouldn't see who's editing it:

```typescript
// With view set, these are automatically protected:
session({ document: "doc123" })   // Only works if user can see doc
presence({ document: "doc123" })  // Only works if user can see doc
```
