# Replicate v2 Migration Plan: Eliminating Zod Dependency

## Executive Summary

**Goal**: Remove Zod as a dependency and use Convex schema as the single source of truth for both server and client.

**Key Changes**:

- Users define schema ONCE in Convex (`convex/schema.ts`)
- Client collections reference the schema directly - no duplicate Zod definitions
- Prose fields are auto-detected by introspecting Convex validators
- Types are inferred from `Doc<"tableName">` - no separate type exports needed
- TanStack DB collections become schema-less (type-only, no `StandardSchemaV1`)

**Breaking**: Yes - this is a v2 with new API signature for `collection.create()`

---

## API Comparison

### Before (v1): Dual Schema Definition

```typescript
// convex/schema.ts - Server schema
import { defineSchema } from "convex/server";
import { v } from "convex/values";
import { schema } from "@trestleinc/replicate/server";

export default defineSchema({
  intervals: schema.table({
    id: v.string(),
    title: v.string(),
    description: schema.prose(),
    status: v.string(),
  }, t => t.index("by_doc_id", ["id"]).index("by_timestamp", ["timestamp"])),
});
```

```typescript
// src/types/interval.ts - DUPLICATE Zod schema
import { z } from "zod";
import { schema } from "@trestleinc/replicate/client";

export const intervalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: schema.prose(),  // Zod prose helper
  status: z.string(),
});

export type Interval = z.infer<typeof intervalSchema>;
```

```typescript
// src/collections/intervals.ts - Collection with Zod schema
import { collection } from "@trestleinc/replicate/client";
import { intervalSchema, type Interval } from "../types/interval";

export const intervals = collection.create({
  persistence: pglite,
  config: () => ({
    schema: intervalSchema,  // Zod schema required
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.intervals,
    getKey: (interval: Interval) => interval.id,
  }),
});

export type { Interval };
```

### After (v2): Single Source of Truth

```typescript
// convex/schema.ts - SINGLE source of truth (unchanged)
import { defineSchema } from "convex/server";
import { v } from "convex/values";
import { schema } from "@trestleinc/replicate/server";

export default defineSchema({
  intervals: schema.table({
    id: v.string(),
    title: v.string(),
    description: schema.prose(),  // Auto-detected on client!
    status: v.string(),
  }, t => t.index("by_doc_id", ["id"]).index("by_timestamp", ["timestamp"])),
});
```

```typescript
// src/collections/intervals.ts - NO ZOD!
import schema from "../../convex/schema";
import { collection } from "@trestleinc/replicate/client";
import { api } from "../../convex/_generated/api";

export const intervals = collection.create(schema, "intervals", {
  persistence: pglite,
  config: () => ({
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.intervals,
    getKey: (interval) => interval.id,  // Fully typed!
  }),
});

// Optional: convenience re-export (users can also use Doc<"intervals"> directly)
export type { Doc } from "../../convex/_generated/dataModel";
```

---

## Type System Architecture

### Type Inference Flow

```
collection.create(schema, "intervals", { ... })
           │           │
           │           └── TableName (string literal)
           │
           └── Schema (typeof schema)
                    │
                    ▼
    DocFromSchema<typeof schema, "intervals">
                    │
                    ▼
    DataModelFromSchemaDefinition<typeof schema>["intervals"]["document"]
                    │
                    ▼
    { _id: Id<"intervals">, _creationTime: number, id: string, title: string, ... }
```

### New Type Definitions

```typescript
// src/client/types.ts (NEW)
import type {
  SchemaDefinition,
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
} from "convex/server";

/**
 * Extract document type from a Convex schema and table name.
 * This mirrors what Convex's generated Doc<> type does, but works
 * directly with the schema object.
 */
export type DocFromSchema<
  Schema extends SchemaDefinition<any, any>,
  TableName extends TableNamesFromSchema<Schema>
> = DocumentByName<
  DataModelFromSchemaDefinition<Schema>,
  TableName
>;

/**
 * Extract valid table names from a schema definition.
 */
export type TableNamesFromSchema<Schema extends SchemaDefinition<any, any>> =
  TableNamesInDataModel<DataModelFromSchemaDefinition<Schema>>;

/**
 * Extract the document type from a LazyCollection.
 * Useful for users who want to extract the type without importing Doc<>.
 */
export type CollectionDoc<C> = C extends LazyCollection<infer T> ? T : never;
```

### Updated `collection.create()` Signature

````typescript
// src/client/collection.ts

export interface CreateCollectionOptions<T extends object> {
  persistence: () => Promise<Persistence>;
  config: () => {
    convexClient: ConvexClient;
    api: ConvexCollectionApi;
    getKey: (item: T) => string;
  };
}

export const collection = {
  /**
   * Create a lazy-initialized collection with automatic type inference.
   *
   * @param schema - The Convex schema object (import from convex/schema.ts)
   * @param table - The table name (must be a key in schema.tables)
   * @param options - Persistence and config factories
   *
   * @example
   * ```typescript
   * import schema from "../convex/schema";
   *
   * export const intervals = collection.create(schema, "intervals", {
   *   persistence: pglite,
   *   config: () => ({
   *     convexClient: new ConvexClient(CONVEX_URL),
   *     api: api.intervals,
   *     getKey: (interval) => interval.id,
   *   }),
   * });
   * ```
   */
  create<
    Schema extends SchemaDefinition<any, any>,
    TableName extends TableNamesFromSchema<Schema>
  >(
    schema: Schema,
    table: TableName,
    options: CreateCollectionOptions<DocFromSchema<Schema, TableName>>
  ): LazyCollection<DocFromSchema<Schema, TableName>>;
};
````

---

## Prose Field Detection

### How It Works

Convex validators are runtime JavaScript objects with introspectable properties:

```typescript
// Runtime structure of schema.tables.intervals.validator
{
  kind: "object",
  fields: {
    id: { kind: "string", isOptional: "required" },
    title: { kind: "string", isOptional: "required" },
    description: {
      kind: "object",
      fields: {
        type: { kind: "literal", value: "doc" },
        content: { kind: "array", element: { kind: "any" }, isOptional: "optional" }
      }
    },
    status: { kind: "string", isOptional: "required" },
  }
}
```

### Detection Implementation

```typescript
// src/client/validators.ts (NEW FILE)
import type { GenericValidator } from "convex/values";

/**
 * Check if a validator represents a prose field.
 * Prose fields match the pattern created by schema.prose():
 * v.object({ type: v.literal("doc"), content: v.optional(v.array(v.any())) })
 */
export function isProseValidator(validator: GenericValidator): boolean {
  const v = validator as any;

  // Must be an object validator
  if (v.kind !== "object" || !v.fields) return false;

  const { type, content } = v.fields;

  // Must have "type" field that is v.literal("doc")
  if (!type || type.kind !== "literal" || type.value !== "doc") {
    return false;
  }

  // Must have "content" field that is an array (optional or required)
  if (!content) return false;

  // Handle optional wrapper
  const contentInner = content.isOptional === "optional" ? content : content;
  if (contentInner.kind !== "array") return false;

  return true;
}

/**
 * Find all prose field names in a table validator.
 *
 * @param validator - The table's validator (schema.tables.X.validator)
 * @returns Array of field names that are prose fields
 */
export function findProseFields(validator: GenericValidator): string[] {
  const v = validator as any;

  if (v.kind !== "object" || !v.fields) return [];

  const proseFields: string[] = [];

  for (const [fieldName, fieldValidator] of Object.entries(v.fields)) {
    // Handle optional wrapper
    let inner = fieldValidator as any;
    if (inner.isOptional === "optional" && inner.kind === "object") {
      // Optional prose field
    }

    if (isProseValidator(inner)) {
      proseFields.push(fieldName);
    }
  }

  return proseFields;
}

/**
 * Create an empty prose value.
 */
export function emptyProse(): { type: "doc"; content: never[] } {
  return { type: "doc", content: [] };
}
```

---

## File-by-File Changes

### Files to Create

| File                       | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `src/client/validators.ts` | `findProseFields()`, `isProseValidator()`, `emptyProse()` |
| `src/client/types.ts`      | `DocFromSchema`, `TableNamesFromSchema`, `CollectionDoc`  |

### Files to Modify

#### `src/client/collection.ts`

**Remove:**

```typescript
// Line 12 - Remove StandardSchemaV1 import
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Line 48 - Remove Zod import
import { z } from "zod";

// Line 29 - Remove Zod extractProseFields import
import { extractProseFields } from "$/client/prose";

// Lines 121-126 - Remove TSchema generic from ConvexCollectionConfig
export interface ConvexCollectionConfig<
  T extends object = object,
  TSchema extends StandardSchemaV1 = never,  // REMOVE
  TKey extends string | number = string | number,
> extends BaseCollectionConfig<T, TKey, TSchema> {
  schema: TSchema;  // REMOVE
  // ...
}

// Lines 180-189 - Remove Zod type constraints from convexCollectionOptions
export function convexCollectionOptions<
  TSchema extends z.ZodObject<z.ZodRawShape>,  // CHANGE
  // ...
>

// Lines 213-214 - Replace Zod extractProseFields with Convex validator version
const proseFields = schema && schema instanceof z.ZodObject
  ? extractProseFields(schema) : [];  // REPLACE

// Lines 843-846, 856, 862-863 - Update type constraints
type LazyCollectionConfig<TSchema extends z.ZodObject<z.ZodRawShape>>  // CHANGE
interface CreateCollectionOptions<TSchema extends z.ZodObject<z.ZodRawShape>>  // CHANGE
create<TSchema extends z.ZodObject<z.ZodRawShape>>  // CHANGE
```

**Add:**

```typescript
// New imports
import type { SchemaDefinition } from "convex/server";
import { findProseFields } from "$/client/validators";
import type { DocFromSchema, TableNamesFromSchema } from "$/client/types";

// New collection.create signature
export const collection = {
  create<
    Schema extends SchemaDefinition<any, any>,
    TableName extends TableNamesFromSchema<Schema>
  >(
    schema: Schema,
    table: TableName,
    options: CreateCollectionOptions<DocFromSchema<Schema, TableName>>
  ): LazyCollection<DocFromSchema<Schema, TableName>> {
    // Get validator from schema
    const tableDefinition = schema.tables[table];
    if (!tableDefinition) {
      throw new Error(`Table "${table}" not found in schema`);
    }

    const validator = tableDefinition.validator;
    const proseFields = findProseFields(validator);

    // ... rest of implementation
  }
};
```

#### `src/client/prose.ts`

**Remove (lines 185-236):**

```typescript
// Remove all Zod-related code
const PROSE_MARKER = Symbol.for("replicate:prose");
function createProseSchema(): z.ZodType<ProseValue> { ... }
function emptyProse(): ProseValue { ... }
export function prose(): z.ZodType<ProseValue> { ... }
prose.empty = emptyProse;
export function isProseSchema(schema: unknown): boolean { ... }
export function extractProseFields(schema: z.ZodObject<z.ZodRawShape>): string[] { ... }
```

**Keep:**

- `observeFragment()` - collaborative editing
- `isPending()` - pending state
- `subscribePending()` - pending subscription
- `cleanup()` - cleanup function

#### `src/client/index.ts`

**Before:**

```typescript
import { extract } from "$/client/merge";
import { prose as proseSchema } from "$/client/prose";

export const schema = {
  prose: Object.assign(proseSchema, {
    extract,
    empty: proseSchema.empty,
  }),
} as const;
```

**After:**

```typescript
import { extract } from "$/client/merge";
import { emptyProse } from "$/client/validators";

export const schema = {
  prose: {
    extract,
    empty: emptyProse,
  },
} as const;

// Export new type utilities
export type { DocFromSchema, TableNamesFromSchema, CollectionDoc } from "$/client/types";
```

#### `src/shared/types.ts`

**Before:**

```typescript
declare const PROSE_BRAND: unique symbol;

export interface ProseValue extends XmlFragmentJSON {
  readonly [PROSE_BRAND]: typeof PROSE_BRAND;
}
```

**After:**

```typescript
// Remove branding - just use structural type
export type ProseValue = XmlFragmentJSON;
```

### Files to Delete

None - all files have non-Zod code worth keeping.

---

## Dependency Changes

### Remove from `package.json`

```diff
  "devDependencies": {
-   "zod": "4.2.1"
  },
  "peerDependencies": {
-   "@standard-schema/spec": "^1.1.0",
  },
  "resolutions": {
-   "@standard-schema/spec": "1.1.0",
-   "zod": "4.2.1"
  },
  "overrides": {
-   "@standard-schema/spec": "1.1.0",
-   "zod": "4.2.1"
  }
```

### Final Peer Dependencies

```json
{
  "peerDependencies": {
    "@tanstack/db": "^0.5.15",
    "convex": "^1.31.0",
    "lib0": "^0.2.0",
    "y-protocols": "^1.0.7",
    "yjs": "^13.6.0"
  }
}
```

---

## Public API Changes

### `@trestleinc/replicate/client` Exports

| v1 Export                                                | v2 Export                                     | Notes                                 |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------------------- |
| `collection.create({ config: () => ({ schema, ... }) })` | `collection.create(schema, "table", { ... })` | **Breaking**: New signature           |
| `schema.prose()`                                         | ❌ **Removed**                                | Use `schema.prose()` from server only |
| `schema.prose.empty`                                     | `schema.prose.empty`                          | Same API, returns plain object        |
| `schema.prose.extract(content)`                          | `schema.prose.extract(content)`               | Unchanged                             |
| -                                                        | `DocFromSchema<S, T>`                         | **New**: Type utility                 |
| -                                                        | `TableNamesFromSchema<S>`                     | **New**: Type utility                 |
| -                                                        | `CollectionDoc<C>`                            | **New**: Type utility                 |

### `@trestleinc/replicate/server` Exports

| v1 Export             | v2 Export             | Notes     |
| --------------------- | --------------------- | --------- |
| `schema.prose()`      | `schema.prose()`      | Unchanged |
| `schema.table()`      | `schema.table()`      | Unchanged |
| `collection.create()` | `collection.create()` | Unchanged |

---

## Example Migrations

### Example 1: Basic Collection

**Before (v1):**

```typescript
// src/types/task.ts
import { z } from "zod";

export const taskSchema = z.object({
  id: z.string(),
  text: z.string(),
  isCompleted: z.boolean(),
});

export type Task = z.infer<typeof taskSchema>;

// src/collections/tasks.ts
import { collection } from "@trestleinc/replicate/client";
import { taskSchema, type Task } from "../types/task";

export const tasks = collection.create({
  persistence: pglite,
  config: () => ({
    schema: taskSchema,
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.tasks,
    getKey: (task: Task) => task.id,
  }),
});

export type { Task };
```

**After (v2):**

```typescript
// src/collections/tasks.ts
import schema from "../../convex/schema";
import { collection } from "@trestleinc/replicate/client";
import { api } from "../../convex/_generated/api";

export const tasks = collection.create(schema, "tasks", {
  persistence: pglite,
  config: () => ({
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.tasks,
    getKey: (task) => task.id,  // Fully typed!
  }),
});

// Optional: Re-export Doc type for convenience
export type { Doc } from "../../convex/_generated/dataModel";
```

### Example 2: Collection with Prose Fields

**Before (v1):**

```typescript
// src/types/note.ts
import { z } from "zod";
import { schema } from "@trestleinc/replicate/client";

export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: schema.prose(),  // Zod prose helper
});

export type Note = z.infer<typeof noteSchema>;

// src/collections/notes.ts
import { collection } from "@trestleinc/replicate/client";
import { noteSchema, type Note } from "../types/note";

export const notes = collection.create({
  persistence: pglite,
  config: () => ({
    schema: noteSchema,
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.notes,
    getKey: (note: Note) => note.id,
  }),
});
```

**After (v2):**

```typescript
// src/collections/notes.ts
import schema from "../../convex/schema";
import { collection } from "@trestleinc/replicate/client";
import { api } from "../../convex/_generated/api";

// Prose fields are AUTO-DETECTED from schema.tables.notes.validator!
export const notes = collection.create(schema, "notes", {
  persistence: pglite,
  config: () => ({
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.notes,
    getKey: (note) => note.id,
  }),
});
```

### Example 3: Using Types in Components

**Before (v1):**

```typescript
import type { Interval } from "../types/interval";

function IntervalCard({ interval }: { interval: Interval }) {
  return <div>{interval.title}</div>;
}
```

**After (v2):**

```typescript
import type { Doc } from "../convex/_generated/dataModel";

function IntervalCard({ interval }: { interval: Doc<"intervals"> }) {
  return <div>{interval.title}</div>;
}

// OR use the collection type utility
import type { CollectionDoc } from "@trestleinc/replicate/client";
import { intervals } from "../collections/intervals";

type Interval = CollectionDoc<typeof intervals>;

function IntervalCard({ interval }: { interval: Interval }) {
  return <div>{interval.title}</div>;
}
```

---

## Migration Checklist for Users

### Step 1: Update Convex Schema (if needed)

Ensure prose fields use `schema.prose()` from `@trestleinc/replicate/server`:

```typescript
// convex/schema.ts
import { schema } from "@trestleinc/replicate/server";

export default defineSchema({
  notes: schema.table({
    content: schema.prose(),  // ✓ Correct
  }, t => t.index("by_doc_id", ["id"]).index("by_timestamp", ["timestamp"])),
});
```

### Step 2: Delete Zod Schema Files

Remove any files that only contain Zod schema definitions:

```bash
# Delete these files
rm src/types/interval.ts
rm src/types/comment.ts
rm src/types/note.ts
```

### Step 3: Update Collection Definitions

```diff
- import { collection } from "@trestleinc/replicate/client";
- import { intervalSchema, type Interval } from "../types/interval";
+ import schema from "../../convex/schema";
+ import { collection } from "@trestleinc/replicate/client";
+ import { api } from "../../convex/_generated/api";

- export const intervals = collection.create({
+ export const intervals = collection.create(schema, "intervals", {
    persistence: pglite,
    config: () => ({
-     schema: intervalSchema,
      convexClient: new ConvexClient(CONVEX_URL),
      api: api.intervals,
-     getKey: (interval: Interval) => interval.id,
+     getKey: (interval) => interval.id,
    }),
  });

- export type { Interval };
```

### Step 4: Update Type Imports

```diff
- import type { Interval } from "../types/interval";
+ import type { Doc } from "../convex/_generated/dataModel";

- function IntervalCard({ interval }: { interval: Interval }) {
+ function IntervalCard({ interval }: { interval: Doc<"intervals"> }) {
```

### Step 5: Remove Zod Dependency

```bash
bun remove zod @standard-schema/spec
```

---

## Edge Cases & Fallbacks

### Explicit Prose Fields Override

For edge cases where prose detection fails, support explicit override:

```typescript
export const notes = collection.create(schema, "notes", {
  // Optional: Explicit prose fields (overrides auto-detection)
  proseFields: ["content", "summary"],
  persistence: pglite,
  config: () => ({ ... }),
});
```

### Validation on Client

For users who want client-side validation (rare):

```typescript
// Users can add their own validation layer
import { z } from "zod";

const validateInterval = z.object({
  title: z.string().min(1),
  status: z.enum(["todo", "done"]),
}).parse;

// Use in handlers
const handleCreate = (data: unknown) => {
  const validated = validateInterval(data);
  collection.insert(validated);
};
```

---

## Implementation Phases

### Phase 1: Core Type System (2-3 hours)

- [ ] Create `src/client/types.ts` with `DocFromSchema`, `TableNamesFromSchema`
- [ ] Create `src/client/validators.ts` with `findProseFields`, `isProseValidator`
- [ ] Add unit tests for prose field detection

### Phase 2: Update Collection API (3-4 hours)

- [ ] Update `collection.create()` signature in `src/client/collection.ts`
- [ ] Remove Zod imports and `extractProseFields` usage
- [ ] Update `convexCollectionOptions()` to use Convex validator
- [ ] Update `src/client/index.ts` exports

### Phase 3: Cleanup (1-2 hours)

- [ ] Remove Zod code from `src/client/prose.ts`
- [ ] Update `src/shared/types.ts` (remove `PROSE_BRAND`)
- [ ] Remove Zod from `package.json`
- [ ] Run build to verify no type errors

### Phase 4: Update Examples (2-3 hours)

- [ ] Migrate `examples/tanstack-start/`
- [ ] Migrate `examples/sveltekit/`
- [ ] Migrate `examples/expo/`
- [ ] Delete all Zod schema files from examples

### Phase 5: Documentation (1-2 hours)

- [ ] Update README.md with new API
- [ ] Update example code in README
- [ ] Add migration guide section
- [ ] Update CHANGELOG.md

---

## Testing Plan

### Unit Tests

```typescript
// tests/validators.test.ts
import { describe, it, expect } from "vitest";
import { findProseFields, isProseValidator } from "../src/client/validators";
import { v } from "convex/values";

describe("isProseValidator", () => {
  it("detects prose validator pattern", () => {
    const proseValidator = v.object({
      type: v.literal("doc"),
      content: v.optional(v.array(v.any())),
    });
    expect(isProseValidator(proseValidator)).toBe(true);
  });

  it("rejects non-prose objects", () => {
    const regularObject = v.object({
      name: v.string(),
      age: v.number(),
    });
    expect(isProseValidator(regularObject)).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isProseValidator(v.string())).toBe(false);
    expect(isProseValidator(v.number())).toBe(false);
  });
});

describe("findProseFields", () => {
  it("finds prose fields in table validator", () => {
    const tableValidator = v.object({
      id: v.string(),
      title: v.string(),
      content: v.object({
        type: v.literal("doc"),
        content: v.optional(v.array(v.any())),
      }),
      description: v.object({
        type: v.literal("doc"),
        content: v.optional(v.array(v.any())),
      }),
    });

    expect(findProseFields(tableValidator)).toEqual(["content", "description"]);
  });

  it("returns empty array for table without prose fields", () => {
    const tableValidator = v.object({
      id: v.string(),
      name: v.string(),
    });

    expect(findProseFields(tableValidator)).toEqual([]);
  });
});
```

### Integration Tests

```typescript
// tests/collection.test.ts
import { describe, it, expect } from "vitest";
import { collection } from "../src/client/collection";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { schema as s } from "../src/server/schema";

const testSchema = defineSchema({
  notes: s.table({
    id: v.string(),
    title: v.string(),
    content: s.prose(),
  }, t => t.index("by_doc_id", ["id"]).index("by_timestamp", ["timestamp"])),
});

describe("collection.create", () => {
  it("infers types from schema", () => {
    const notes = collection.create(testSchema, "notes", {
      persistence: async () => persistence.memory(),
      config: () => ({
        convexClient: mockClient,
        api: mockApi,
        getKey: (note) => note.id,  // Should be typed!
      }),
    });

    expect(notes).toBeDefined();
  });

  it("throws for invalid table name", () => {
    expect(() => {
      // @ts-expect-error - invalid table name
      collection.create(testSchema, "invalid", { ... });
    }).toThrow('Table "invalid" not found in schema');
  });
});
```

---

## Rollback Plan

If issues are discovered post-release:

1. **v2.0.1**: Patch with fixes
2. **v1.x maintenance**: Continue supporting v1 for 3 months
3. **Codemod**: Provide automated migration script if needed

```bash
# Potential codemod for users
npx @trestleinc/replicate-codemod v1-to-v2
```

---

## Success Metrics

- [ ] Zero Zod imports in library code
- [ ] All examples work without Zod
- [ ] Type inference works correctly (manual verification)
- [ ] Prose field detection works for all test cases
- [ ] Build size reduced (no Zod bundle)
- [ ] All existing tests pass
