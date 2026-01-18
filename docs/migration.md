# Replicate Migration System

Schema migrations for local-first apps with zero mental overhead.

## Overview

**The key insight: schema diffs can be computed automatically.** You write ONE migration (server-side), and client migrations happen automatically.

```
┌─────────────────────────────────────────────────────────────────┐
│  YOU DO THIS:                                                    │
│                                                                  │
│  1. Bump schema version                                          │
│  2. Write normal Convex migration                                │
│  3. Deploy                                                       │
│                                                                  │
│  SYSTEM DOES THIS:                                               │
│                                                                  │
│  ✓ Detects schema changes                                        │
│  ✓ Generates SQLite migrations                                   │
│  ✓ Migrates Yjs documents                                        │
│  ✓ Handles offline clients                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Define Your Schema

```typescript
// convex/schema/tasks.ts
import { schema } from "@trestleinc/replicate/server";
import { v } from "convex/values";

export const taskSchema = schema.define({
  version: 1,
  shape: v.object({
    id: v.string(),
    title: v.string(),
    completed: v.boolean(),
    content: schema.prose(),
  }),
});

// Type inference
import type { Infer } from "convex/values";
type Task = Infer<typeof taskSchema.shape>;
```

### 2. Add a Field (Version 2)

```typescript
// convex/schema/tasks.ts
import { schema } from "@trestleinc/replicate/server";
import { v } from "convex/values";

export const taskSchema = schema.define({
  version: 2,  // Bump version

  shape: v.object({
    id: v.string(),
    title: v.string(),
    completed: v.boolean(),
    priority: v.optional(v.string()),  // New field (optional in validator)
    content: schema.prose(),
  }),

  // Defaults applied during migrations
  defaults: {
    priority: "medium",
  },

  // Keep history for diffing (optional but recommended)
  history: {
    1: v.object({
      id: v.string(),
      title: v.string(),
      completed: v.boolean(),
      content: schema.prose(),
    }),
  },
});
```

### 3. Write Server Migration

```typescript
// convex/migrations/tasks.ts
import { taskSchema } from "../schema/tasks";

export const taskMigrations = taskSchema.migrations({
  2: {
    name: "add-priority-field",
    migrate: async (ctx, doc) => {
      // Normal Convex migration - exactly like @convex-dev/migrations
      await ctx.db.patch(doc._id, { priority: "medium" });
    },
  },
});
```

### 4. Client Setup (No Migration Code!)

```typescript
// src/collections/tasks.ts
import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { taskSchema } from "../convex/schema/tasks";
import { api } from "../convex/_generated/api";

export const tasks = collection.create({
  schema: taskSchema,  // Version info included
  persistence: () => persistence.web.sqlite(),
  config: () => ({
    convexClient: new ConvexClient(import.meta.env.VITE_CONVEX_URL),
    api: api.tasks,
    getKey: (task) => task.id,
  }),
});

// Migrations run automatically
await tasks.init();
```

**That's it.** The client automatically detects the version mismatch and migrates.

---

## How It Works

### Auto-Diff Engine

The system computes schema differences automatically:

```
v1 Schema                    v2 Schema
───────────                  ───────────
id: string                   id: string
title: string         →      title: string
completed: boolean           completed: boolean
content: prose               content: prose
                             priority: string (NEW)

Detected Operations:
  + add_column: priority TEXT DEFAULT 'medium'

Generated SQL:
  ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium'
```

### Migration Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                     DEVELOPMENT                                   │
├──────────────────────────────────────────────────────────────────┤
│  1. Change schema (bump version)                                  │
│  2. Write server migration                                        │
│  3. Deploy: npx convex deploy                                     │
│  4. Run migration: npx convex run migrations:run                  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                      RUNTIME (Automatic)                          │
├──────────────────────────────────────────────────────────────────┤
│  1. Client calls tasks.init()                                     │
│  2. System detects version mismatch (local v1, server v2)         │
│  3. System computes diff automatically                            │
│  4. System generates SQLite migration                             │
│  5. System runs migration in transaction                          │
│  6. System updates Yjs documents                                  │
│  7. Done!                                                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## Schema Definition API

### Basic Schema

```typescript
import { schema } from "@trestleinc/replicate/server";
import { v } from "convex/values";

export const userSchema = schema.define({
  version: 1,
  shape: v.object({
    id: v.string(),
    name: v.string(),
    email: v.string(),
    createdAt: v.number(),
  }),
});
```

### With Prose Fields

```typescript
export const postSchema = schema.define({
  version: 1,
  shape: v.object({
    id: v.string(),
    title: v.string(),
    content: schema.prose(),  // Rich text (Yjs)
    published: v.optional(v.boolean()),
  }),
  defaults: {
    published: false,
  },
});
```

### With Version History

```typescript
export const taskSchema = schema.define({
  version: 3,

  shape: v.object({
    id: v.string(),
    title: v.string(),
    status: v.union(v.literal("todo"), v.literal("doing"), v.literal("done")),  // Changed in v3
    priority: v.optional(v.string()),  // Added in v2
    content: schema.prose(),
  }),

  defaults: {
    status: "todo",
    priority: "medium",
  },

  history: {
    1: v.object({
      id: v.string(),
      title: v.string(),
      completed: v.boolean(),
      content: schema.prose(),
    }),
    2: v.object({
      id: v.string(),
      title: v.string(),
      completed: v.boolean(),
      priority: v.optional(v.string()),
      content: schema.prose(),
    }),
  },
});
```

### Type Inference

```typescript
import type { Infer } from "convex/values";

// Types are inferred from the validator
type Task = Infer<typeof taskSchema.shape>;
// => { id: string; title: string; status: "todo" | "doing" | "done"; ... }

// Get schema for specific version
const v1Schema = taskSchema.getVersion(1);
type TaskV1 = Infer<typeof v1Schema>;
```

---

## Server Migrations

Server migrations use standard `@convex-dev/migrations` patterns:

### Basic Migration

```typescript
// convex/migrations/tasks.ts
import { taskSchema } from "../schema/tasks";

export const taskMigrations = taskSchema.migrations({
  2: {
    name: "add-priority-field",
    migrate: async (ctx, doc) => {
      await ctx.db.patch(doc._id, { priority: "medium" });
    },
  },
});
```

### Complex Migration (Query Other Tables)

```typescript
export const taskMigrations = taskSchema.migrations({
  3: {
    name: "convert-completed-to-status",
    migrate: async (ctx, doc) => {
      // Complex logic that can't be auto-generated
      const owner = await ctx.db.get(doc.ownerId);
      const status = doc.completed
        ? "done"
        : owner?.defaultStatus ?? "todo";

      await ctx.db.patch(doc._id, {
        status,
        completed: undefined,  // Remove old field
      });
    },
  },
});
```

### Batch Configuration

```typescript
export const taskMigrations = taskSchema.migrations({
  2: {
    name: "add-priority-field",
    batchSize: 50,  // Smaller batches for large documents
    parallelize: true,  // Run in parallel within batch
    migrate: async (ctx, doc) => {
      await ctx.db.patch(doc._id, { priority: "medium" });
    },
  },
});
```

### Register with Migration Runner

```typescript
// convex/migrations/index.ts
import { migrations } from "@convex-dev/migrations";
import { components, internal } from "../_generated/api";
import { taskMigrations } from "./tasks";

export const run = migrations(components.migrations, {
  run: internal.migrations.run,
});

// Export for CLI
export const { run: runTaskMigrations } = taskMigrations.register(run);
```

---

## Client Configuration

### Basic Setup

```typescript
import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { taskSchema } from "../convex/schema/tasks";
import { api } from "../convex/_generated/api";

export const tasks = collection.create({
  schema: taskSchema,
  persistence: () => persistence.web.sqlite(),
  config: () => ({
    convexClient: new ConvexClient(import.meta.env.VITE_CONVEX_URL),
    api: api.tasks,
    getKey: (task) => task.id,
  }),
});
```

### With Error Recovery

```typescript
export const tasks = collection.create({
  schema: taskSchema,
  persistence: () => persistence.web.sqlite(),
  config: () => ({ /* ... */ }),

  onMigrationError: async (error, context) => {
    console.error("Migration failed:", error.message);

    // Check if we can safely reset
    if (context.canResetSafely) {
      // No unsynced changes - safe to wipe and resync
      return { action: "reset" };
    }

    if (context.pendingChanges > 0) {
      // Has unsynced changes - keep old schema, warn user
      console.warn(`${context.pendingChanges} changes would be lost`);
      return { action: "keep-old-schema" };
    }

    // Retry with exponential backoff
    return { action: "retry" };
  },
});
```

### Custom Client Migrations

For cases where auto-diff isn't sufficient:

```typescript
export const tasks = collection.create({
  schema: taskSchema,
  persistence: () => persistence.web.sqlite(),
  config: () => ({ /* ... */ }),

  // Override auto-generated migration
  clientMigrations: {
    3: async (db, ctx) => {
      // Custom SQLite logic
      await db.run(`
        ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'todo';
        UPDATE tasks SET status =
          CASE
            WHEN completed = 1 THEN 'done'
            ELSE 'todo'
          END;
        ALTER TABLE tasks DROP COLUMN completed;
      `);

      // Custom Yjs logic
      for (const doc of ctx.dirtyDocs) {
        const ydoc = ctx.getYDoc(doc.id);
        const fields = ydoc.getMap("fields");
        ydoc.transact(() => {
          const completed = fields.get("completed");
          fields.set("status", completed ? "done" : "todo");
          fields.delete("completed");
        });
      }
    },
  },
});
```

---

## Recovery Actions

When migrations fail, the `onMigrationError` hook receives context about the failure:

```typescript
interface MigrationError {
  code: "SCHEMA_MISMATCH" | "SQLITE_ERROR" | "YJS_ERROR" | "NETWORK_ERROR";
  message: string;
  fromVersion: number;
  toVersion: number;
  operation?: SchemaDiffOperation;  // Which operation failed
}

interface RecoveryContext {
  error: MigrationError;
  canResetSafely: boolean;  // True if no unsynced local changes
  pendingChanges: number;   // Count of unsynced changes
  lastSyncedAt: Date | null;
}
```

Available recovery actions:

| Action                              | Effect                                           |
| ----------------------------------- | ------------------------------------------------ |
| `{ action: "reset" }`               | Wipe local data, resync from server              |
| `{ action: "keep-old-schema" }`     | Continue with old schema (limited functionality) |
| `{ action: "retry" }`               | Retry migration with exponential backoff         |
| `{ action: "custom", handler: fn }` | Run custom recovery logic                        |

---

## Backwards Compatibility

### Safe Changes (Auto-Migrated)

These changes are backwards compatible and auto-migrate:

```typescript
// Adding optional field
priority: v.optional(v.string())

// Adding field with default in defaults object
shape: v.object({
  priority: v.optional(v.string()),
}),
defaults: {
  priority: "medium",
},

// Adding new collection
// (Just define new schema, no migration needed)
```

### Breaking Changes (Require Attention)

These changes are NOT backwards compatible:

| Change                             | Problem                                          |
| ---------------------------------- | ------------------------------------------------ |
| Removing field                     | Old clients will crash when accessing this field |
| Adding required field (no default) | Old documents don't have this field              |
| Changing field type                | Type mismatch will cause errors                  |

**Recommendations:**

1. Make new fields optional or add default
2. Keep deprecated fields, remove in future version
3. Add new field instead of changing type

### Deprecation Pattern

```typescript
// Version 2: Add new field, keep old
export const taskSchema = schema.define({
  version: 2,
  shape: v.object({
    id: v.string(),
    completed: v.boolean(),  // Deprecated, but kept
    status: v.optional(v.string()),  // New
  }),
  defaults: {
    status: "todo",
  },
});

// Version 3: Remove old field (after all clients upgraded)
export const taskSchema = schema.define({
  version: 3,
  shape: v.object({
    id: v.string(),
    status: v.union(v.literal("todo"), v.literal("doing"), v.literal("done")),
  }),
  defaults: {
    status: "todo",
  },
  history: { 1: v1Schema, 2: v2Schema },
});
```

---

## Auto-Diff Operations

The diff engine detects these operations:

| Change                 | Detection          | SQL Generated                            |
| ---------------------- | ------------------ | ---------------------------------------- |
| Add field with default | `+ field`          | `ALTER TABLE ADD COLUMN ... DEFAULT`     |
| Add optional field     | `+ field?`         | `ALTER TABLE ADD COLUMN ...`             |
| Remove field           | `- field`          | `ALTER TABLE DROP COLUMN` (SQLite 3.35+) |
| Rename field           | `field → newField` | `ALTER TABLE RENAME COLUMN`              |
| Change type            | `field: T1 → T2`   | Requires custom migration                |
| Add collection         | `+ collection`     | `CREATE TABLE`                           |
| Remove collection      | `- collection`     | `DROP TABLE`                             |

### Computed Diff API

```typescript
// Get diff between versions
const diff = taskSchema.diff(1, 2);

console.log(diff);
// {
//   fromVersion: 1,
//   toVersion: 2,
//   operations: [
//     { type: "add_column", table: "tasks", column: "priority", defaultValue: "medium" }
//   ],
//   isBackwardsCompatible: true,
//   generatedSQL: "ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium'"
// }
```

---

## TypeScript Types

### Schema Types

```typescript
import type {
  VersionedSchema,
  SchemaDefinition,
  SchemaDiff,
  SchemaDiffOperation,
} from "@trestleinc/replicate/server";
```

### Migration Types

```typescript
import type {
  MigrationDefinition,
  MigrationContext,
  ClientMigrationContext,
  ClientMigrationFn,
} from "@trestleinc/replicate/server";
```

### Recovery Types

```typescript
import type {
  MigrationError,
  RecoveryContext,
  RecoveryAction,
  MigrationErrorHandler,
} from "@trestleinc/replicate/client";
```

---

## Examples

### Complete Task App

```typescript
// convex/schema/tasks.ts
import { schema } from "@trestleinc/replicate/server";
import { v } from "convex/values";

export const taskSchema = schema.define({
  version: 2,
  shape: v.object({
    id: v.string(),
    title: v.string(),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    content: schema.prose(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  defaults: {
    status: "todo",
    priority: "medium",
  },
  history: {
    1: v.object({
      id: v.string(),
      title: v.string(),
      completed: v.boolean(),
      content: schema.prose(),
      createdAt: v.number(),
    }),
  },
});

// convex/migrations/tasks.ts
export const taskMigrations = taskSchema.migrations({
  2: {
    name: "add-status-and-priority",
    migrate: async (ctx, doc) => {
      await ctx.db.patch(doc._id, {
        status: doc.completed ? "done" : "todo",
        priority: "medium",
        updatedAt: Date.now(),
        completed: undefined,
      });
    },
  },
});

// src/collections/tasks.ts
import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { taskSchema } from "../convex/schema/tasks";
import { api } from "../convex/_generated/api";

export const tasks = collection.create({
  schema: taskSchema,
  persistence: () => persistence.web.sqlite(),
  config: () => ({
    convexClient: new ConvexClient(import.meta.env.VITE_CONVEX_URL),
    api: api.tasks,
    getKey: (task) => task.id,
  }),
  onMigrationError: async (error, ctx) => {
    if (ctx.canResetSafely) return { action: "reset" };
    return { action: "keep-old-schema" };
  },
});
```

### Enum Value Migration

```typescript
// Change status values: open/closed → todo/done
export const taskMigrations = taskSchema.migrations({
  3: {
    name: "update-status-values",
    migrate: async (ctx, doc) => {
      const statusMap: Record<string, string> = {
        "open": "todo",
        "in-progress": "doing",
        "closed": "done",
      };
      await ctx.db.patch(doc._id, {
        status: statusMap[doc.status] ?? "todo",
      });
    },
  },
});
```

### Denormalization Migration

```typescript
// Copy owner name into task for faster reads
export const taskMigrations = taskSchema.migrations({
  4: {
    name: "denormalize-owner-name",
    migrate: async (ctx, doc) => {
      const owner = await ctx.db.get(doc.ownerId);
      await ctx.db.patch(doc._id, {
        ownerName: owner?.name ?? "Unknown",
      });
    },
  },
});
```

---

## Design Decisions

### Why Convex Validators?

1. **Already in ecosystem** - Convex developers use `v` validators
2. **No extra dependency** - Zod would add bundle size
3. **Consistent** - Same validators on client and server
4. **Rich introspection** - Can diff schemas programmatically

### Why Separate `defaults` Object?

Convex validators don't have a `.default()` method like Zod. The `defaults` object:

1. **Explicit** - Clear separation between shape and defaults
2. **Migration-focused** - Defaults are for migrations, not validation
3. **Type-safe** - Can enforce default types match field types

### Why Auto-Generate Client Migrations?

1. **90% of migrations are simple** - Add column, remove column, rename
2. **Less code = fewer bugs** - Users focus on business logic
3. **Escape hatch exists** - Custom migrations for the 10%

### Why Version Numbers?

1. **Simple mental model** - "I'm on v2, server is v3"
2. **Clear migration path** - Run v2 → v3, not arbitrary transforms
3. **History tracking** - Can diff any two versions

### Why Not Bidirectional Lenses (Cambria)?

1. **Complexity** - Lenses are hard to reason about
2. **Debugging** - Version numbers are easier to debug
3. **Practicality** - Most apps don't need bidirectional

---

## Migration Checklist

1. **Bump version** in schema definition
2. **Write server migration** if needed
3. **Deploy to Convex**: `npx convex deploy`
4. **Run server migration**: `npx convex run migrations:run`
5. **Deploy client** - auto-migrates on init

---

## Troubleshooting

### "Schema version mismatch"

Client is behind server. Call `collection.init()` to migrate.

### "Migration failed: SQLITE_ERROR"

Check if you're dropping columns on SQLite < 3.35. Use custom migration or table recreation.

### "Cannot migrate: pending changes"

Local changes haven't synced. Either:

1. Wait for sync
2. Use `{ action: "reset" }` to discard local changes

### "Breaking change detected"

Your change isn't backwards compatible. Either:

1. Make field optional/add default
2. Use deprecation pattern
3. Accept that old clients will error
