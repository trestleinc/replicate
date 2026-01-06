# Replicate Migration System

A local-first schema migration system that works with CRDTs and Convex.

## Overview

Traditional database migrations assume a central server that can coordinate schema changes. In a local-first architecture, clients may be offline for extended periods and reconnect with outdated schemas. This system enables:

- **Per-document schema versioning** - Documents migrate independently
- **Non-blocking background migration** - Users can work while migration runs
- **Automatic rename detection** - Via stable field identifiers
- **Bidirectional execution** - Same migration runs on server (Convex) and client (SQLite/Yjs)

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Field Identity System](#field-identity-system)
3. [Migration Primitives](#migration-primitives)
4. [Schema Diffing](#schema-diffing)
5. [Execution Model](#execution-model)
6. [Integration with Convex](#integration-with-convex)
7. [Client-Side Execution](#client-side-execution)
8. [API Reference](#api-reference)

---

## Core Concepts

### The Problem

When a client reconnects after being offline:

```
Client (schema v2) <-- Server sends v4 data
```

The CRDT merge will fail or produce incorrect results if the schemas don't match. We need to:

1. Detect the schema version mismatch
2. Fetch migration definitions from the server
3. Migrate local data to the current schema
4. Resume sync with matching schemas

### Key Insight: Migrate First, Then Merge

CRDTs handle concurrent edits beautifully when both sides have the same **shape**. The solution is simple:

1. **Migrate local data first** (transform to current schema)
2. **Then apply server deltas** (CRDTs merge cleanly)

### Sequence Numbers, Not Timestamps

We use monotonic sequence numbers (`seq`) for ordering, not timestamps. Timestamps have clock skew issues in distributed systems. The `seq` system provides:

- Total ordering per collection
- Atomic increment on server
- Reliable cursor-based pagination
- No clock synchronization needed

---

## Field Identity System

### The Rename Problem

Without field identity, renames are ambiguous:

```typescript
// v1: { userName: "alice" }
// v2: { displayName: "alice" }

// Is this:
// A) Rename: userName -> displayName
// B) Delete userName + Add displayName
```

### Solution: Stable Field IDs

Every field gets a unique, stable identifier that persists across renames:

```typescript
// v1
{
  fields: { userName: "alice" },
  _fieldIds: { "userName": "f_abc123" }
}

// v2 (after rename)
{
  fields: { displayName: "alice" },
  _fieldIds: { "displayName": "f_abc123" }  // Same ID!
}
```

The diff algorithm sees: `f_abc123` moved from `userName` to `displayName` = **RENAME**

### Yjs Document Structure

```typescript
// Current structure
{
  fields: Y.Map,      // Actual field values
  _meta: Y.Map        // { _deleted, _schemaVersion, ... }
}

// With field identity
{
  fields: Y.Map,      // Actual field values
  _meta: Y.Map,       // { _deleted, _schemaVersion, ... }
  _fieldIds: Y.Map    // { fieldPath: fieldId, ... }
}
```

### Nested Objects

For nested fields, use dot-notation paths:

```typescript
{
  fields: {
    profile: {
      settings: {
        theme: "dark"
      }
    }
  },
  _fieldIds: {
    "profile": "f_001",
    "profile.settings": "f_002",
    "profile.settings.theme": "f_003"
  }
}
```

### Field ID Generation

Field IDs are generated:

1. **On document creation** - Each field gets a new UUID
2. **On field addition** - New fields get new IDs
3. **On rename** - ID moves to new path (preserved)

```typescript
function generateFieldId(): string {
  return `f_${crypto.randomUUID().slice(0, 12)}`;
}
```

---

## Migration Primitives

Migrations are composed of a **finite set of primitive operations**. No arbitrary code - everything is serializable and deterministic.

### Structural Operations

```typescript
// Add a new field with default value
{ op: "add"; path: string; type: FieldType; default: unknown }

// Remove a field
{ op: "remove"; path: string }

// Move/rename a field (preserves field ID)
{ op: "move"; from: string; to: string }
```

### Type Conversion Operations

All valid type conversions are enumerable:

```typescript
{ op: "convert"; path: string; to: FieldType; using: ConversionFn }
```

**Valid Conversions:**

| From | To | Function | Example |
|------|-----|----------|---------|
| string | number | `parseFloat` | `"3.14"` -> `3.14` |
| string | number | `parseInt` | `"42"` -> `42` |
| number | string | `toString` | `42` -> `"42"` |
| string | boolean | `parseBool` | `"true"` -> `true` |
| boolean | string | `toString` | `true` -> `"true"` |
| string | array | `split` | `"a,b"` -> `["a","b"]` |
| array | string | `join` | `["a","b"]` -> `"a,b"` |
| any | array | `wrap` | `"x"` -> `["x"]` |
| array | any | `first` | `["x","y"]` -> `"x"` |

### Value Transformation Operations

```typescript
// Map old values to new values (enum changes)
{ op: "mapValues"; path: string; mapping: Record<string, unknown> }

// Set default for null/undefined values
{ op: "setDefault"; path: string; value: unknown; when: "null" | "undefined" }
```

### Field Types

```typescript
type FieldType = 
  | "string" 
  | "number" 
  | "boolean" 
  | "null"
  | "array" 
  | "object"
  | "prose"  // Y.XmlFragment for rich text
```

### Complete Type Definition

```typescript
type MigrationOp =
  // Structural
  | { op: "add"; path: string; type: FieldType; default: unknown }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; to: string }
  
  // Type conversion
  | { op: "convert"; path: string; to: FieldType; using: ConversionFn }
  
  // Value transformation
  | { op: "mapValues"; path: string; mapping: Record<string, unknown> }
  | { op: "setDefault"; path: string; value: unknown; when: "null" | "undefined" }

type ConversionFn =
  | "toString"
  | "parseFloat"
  | "parseInt"
  | "parseBool"
  | { fn: "split"; delimiter: string }
  | { fn: "join"; delimiter: string }
  | "first"
  | "wrap"
```

---

## Schema Diffing

### Schema Snapshots

At build time, we serialize the Convex schema to JSON:

```typescript
interface SchemaSnapshot {
  [tableName: string]: {
    fields: ValidatorJSON;
    indexes: IndexDefinition[];
    _fieldIds: Record<string, string>;  // path -> fieldId
  }
}
```

Snapshots are stored in version control (`.convex/_schema_snapshot.json`) to enable diffing between versions.

### Diff Algorithm

```typescript
function diffSchemas(
  prev: SchemaSnapshot,
  curr: SchemaSnapshot
): SchemaDiff[] {
  const diffs: SchemaDiff[] = [];
  
  for (const [table, currDef] of Object.entries(curr)) {
    const prevDef = prev[table];
    
    // Build fieldId -> path reverse map for rename detection
    const idToPath = new Map<string, string>();
    if (prevDef?._fieldIds) {
      for (const [path, id] of Object.entries(prevDef._fieldIds)) {
        idToPath.set(id, path);
      }
    }
    
    const changes: MigrationOp[] = [];
    
    // Detect adds, moves, and type changes
    for (const [path, fieldId] of Object.entries(currDef._fieldIds)) {
      if (idToPath.has(fieldId)) {
        const prevPath = idToPath.get(fieldId)!;
        
        // Rename detected
        if (prevPath !== path) {
          changes.push({ op: "move", from: prevPath, to: path });
        }
        
        // Type change detected
        const prevType = getFieldType(prevDef, prevPath);
        const currType = getFieldType(currDef, path);
        if (prevType !== currType) {
          const conversion = suggestConversion(prevType, currType);
          changes.push({ op: "convert", path, to: currType, using: conversion });
        }
        
        idToPath.delete(fieldId);  // Mark as processed
      } else {
        // New field
        changes.push({ 
          op: "add", 
          path, 
          type: getFieldType(currDef, path),
          default: getDefaultValue(currDef, path)
        });
      }
    }
    
    // Remaining IDs in map are removals
    for (const [fieldId, path] of idToPath) {
      changes.push({ op: "remove", path });
    }
    
    if (changes.length > 0) {
      diffs.push({ table, changes });
    }
  }
  
  return diffs;
}
```

### Auto-Suggested Conversions

When a type change is detected, we suggest the appropriate conversion:

```typescript
function suggestConversion(from: FieldType, to: FieldType): ConversionFn {
  const key = `${from}->${to}`;
  const suggestions: Record<string, ConversionFn> = {
    "string->number": "parseFloat",
    "number->string": "toString",
    "string->boolean": "parseBool",
    "boolean->string": "toString",
    "any->array": "wrap",
    "array->any": "first",
  };
  return suggestions[key] ?? "toString";
}
```

---

## Execution Model

### Per-Document Versioning

Each document tracks its own schema version:

```typescript
// In _meta map
{
  _schemaVersion: 3,
  _deleted: false
}
```

This enables:
- **Partial migration** - Some docs at v2, others at v4
- **Non-blocking progress** - Migrate in batches
- **Graceful degradation** - Old docs still readable

### Background Migration Manager

```typescript
interface MigrationManager {
  // Check if any documents need migration
  needsMigration(collection: string): Promise<boolean>;
  
  // Start non-blocking background migration
  startMigration(collection: string, options?: {
    batchSize?: number;           // Default: 10
    priority?: "visible" | "recent" | "all";
    onProgress?: (state: MigrationState) => void;
  }): MigrationHandle;
  
  // Get current migration state
  getState(collection: string): MigrationState;
  
  // Migrate single document (for lazy/on-read)
  migrateDocument(collection: string, docId: string): Promise<void>;
}

interface MigrationState {
  status: "idle" | "running" | "done" | "error";
  total: number;
  completed: number;
  percent: number;
  currentDoc?: string;
}

interface MigrationHandle {
  pause(): void;
  resume(): void;
  cancel(): void;
  waitForCompletion(): Promise<void>;
}
```

### Migration Tracking Table (SQLite)

```sql
CREATE TABLE IF NOT EXISTS __migrations (
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, migrating, done, error
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, doc_id)
);

CREATE INDEX migrations_pending_idx 
  ON __migrations (collection, status) 
  WHERE status = 'pending';
```

---

## Integration with Convex

### Migration Definition

Migrations are defined using `@convex-dev/migrations` with additional metadata:

```typescript
// convex/migrations/20260106_add_email.ts
import { migrations } from "./index";

// Migration metadata (for client-side execution)
export const directive = {
  version: 4,
  seq: 20260106120000,
  table: "users",
  operations: [
    { op: "add", path: "email", type: "string", default: "" },
    { op: "move", from: "emailAddress", to: "email" },
    { op: "remove", path: "emailAddress" },
  ],
} as const;

// Server-side migration (Convex)
export const migration = migrations.define({
  table: "users",
  migrateOne: async (ctx, doc) => {
    return {
      email: doc.emailAddress ?? "",
      emailAddress: undefined,
    };
  },
});
```

### Schema Version Table

```typescript
// In component schema
schemaVersions: defineTable({
  collection: v.string(),
  version: v.number(),
  seq: v.number(),
})
.index("by_collection", ["collection"])

// Server tracks current version per collection
schemaMigrations: defineTable({
  collection: v.string(),
  version: v.number(),
  seq: v.number(),
  operations: v.array(v.any()),  // MigrationOp[]
  hash: v.string(),
})
.index("by_collection_version", ["collection", "version"])
```

### Sync Protocol Extension

```typescript
// Extended stream response
interface StreamResult {
  changes: Change[];
  seq: number;
  more: boolean;
  
  // Schema info included when client is behind
  schema?: {
    version: number;
    migrations?: {
      version: number;
      operations: MigrationOp[];
    }[];
  };
}
```

---

## Client-Side Execution

### Migration Flow

```
1. Client connects, sends current seq + schema version
2. Server responds with:
   - Normal deltas (if schema matches)
   - Schema info + migrations (if client is behind)
3. Client queues documents for migration
4. Background worker migrates in batches
5. For each document:
   a. Load Yjs doc
   b. Apply migration operations
   c. Update _meta._schemaVersion
   d. Save to SQLite
   e. Mark done in __migrations table
6. Once all migrated, resume normal sync
```

### Execution Engine

```typescript
function executeMigration(ydoc: Y.Doc, ops: MigrationOp[]): void {
  const fields = ydoc.getMap("fields");
  const fieldIds = ydoc.getMap("_fieldIds");
  const meta = ydoc.getMap("_meta");
  
  ydoc.transact(() => {
    for (const op of ops) {
      executeOp(fields, fieldIds, op);
    }
  }, "migration");
}

function executeOp(
  fields: Y.Map<unknown>,
  fieldIds: Y.Map<string>,
  op: MigrationOp
): void {
  switch (op.op) {
    case "add": {
      if (!hasPath(fields, op.path)) {
        setPath(fields, op.path, op.default);
        fieldIds.set(op.path, generateFieldId());
      }
      break;
    }
    
    case "remove": {
      deletePath(fields, op.path);
      fieldIds.delete(op.path);
      break;
    }
    
    case "move": {
      const value = getPath(fields, op.from);
      const id = fieldIds.get(op.from);
      
      setPath(fields, op.to, value);
      if (id) fieldIds.set(op.to, id);
      
      deletePath(fields, op.from);
      fieldIds.delete(op.from);
      break;
    }
    
    case "convert": {
      const oldValue = getPath(fields, op.path);
      const newValue = applyConversion(oldValue, op.using);
      setPath(fields, op.path, newValue);
      break;
    }
    
    case "mapValues": {
      const oldValue = getPath(fields, op.path);
      const newValue = op.mapping[String(oldValue)] ?? oldValue;
      setPath(fields, op.path, newValue);
      break;
    }
    
    case "setDefault": {
      const value = getPath(fields, op.path);
      const shouldSet = 
        (op.when === "null" && value === null) ||
        (op.when === "undefined" && value === undefined);
      if (shouldSet) {
        setPath(fields, op.path, op.value);
      }
      break;
    }
  }
}
```

### Path Utilities

```typescript
function getPath(map: Y.Map<unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = map;
  
  for (const part of parts) {
    if (current instanceof Y.Map) {
      current = current.get(part);
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  
  return current;
}

function setPath(map: Y.Map<unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  const lastKey = parts.pop()!;
  
  let current: Y.Map<unknown> = map;
  for (const part of parts) {
    let next = current.get(part);
    if (!(next instanceof Y.Map)) {
      next = new Y.Map();
      current.set(part, next);
    }
    current = next as Y.Map<unknown>;
  }
  
  current.set(lastKey, value);
}

function deletePath(map: Y.Map<unknown>, path: string): void {
  const parts = path.split(".");
  const lastKey = parts.pop()!;
  
  let current: Y.Map<unknown> = map;
  for (const part of parts) {
    const next = current.get(part);
    if (!(next instanceof Y.Map)) return;
    current = next as Y.Map<unknown>;
  }
  
  current.delete(lastKey);
}

function hasPath(map: Y.Map<unknown>, path: string): boolean {
  return getPath(map, path) !== undefined;
}
```

### Conversion Functions

```typescript
function applyConversion(value: unknown, fn: ConversionFn): unknown {
  if (typeof fn === "string") {
    switch (fn) {
      case "toString":
        return String(value);
      case "parseFloat":
        return parseFloat(String(value));
      case "parseInt":
        return parseInt(String(value), 10);
      case "parseBool":
        return value === "true" || value === true || value === 1;
      case "wrap":
        return [value];
      case "first":
        return Array.isArray(value) ? value[0] : value;
    }
  } else {
    switch (fn.fn) {
      case "split":
        return String(value).split(fn.delimiter);
      case "join":
        return Array.isArray(value) ? value.join(fn.delimiter) : String(value);
    }
  }
  return value;
}
```

---

## API Reference

### Migration Definition

```typescript
import { migration } from "@trestleinc/replicate/server";

// Define a migration with operations
export const myMigration = migration.define({
  table: "users",
  version: 2,
  operations: [
    { op: "add", path: "email", type: "string", default: "" },
  ],
  // Optional: custom migrateOne for complex logic
  migrateOne: async (ctx, doc) => {
    return { email: doc.oldEmail ?? "" };
  },
});
```

### Client Usage

```typescript
import { collection } from "@trestleinc/replicate/client";

// Migrations are applied automatically during sync
const intervals = collection.create(schema, "intervals", {
  persistence: sqlite,
  config: () => ({
    convexClient,
    api: api.intervals,
    // ...
  }),
});

// Check migration status
const state = intervals.migration.getState();
console.log(`Migration: ${state.percent}% complete`);

// Subscribe to progress
intervals.migration.onProgress((state) => {
  if (state.status === "running") {
    showProgressBar(state.percent);
  }
});
```

### CLI Commands

```bash
# Generate migration from schema changes
npx replicate migrate:generate
Failed to unlock


# Run server-side migration
npx convex run migrations:run '{"fn": "migrations:myMigration"}'

# Check migration status
npx convex run migrations:status
```

---

## Design Decisions

### Why Field IDs?

- **Unambiguous rename detection** - No heuristics needed
- **Unix-like philosophy** - Inodes don't change when you rename files
- **CRDT-friendly** - Merges work correctly across schema versions

### Why Primitive Operations?

- **Serializable** - Can be stored in database, sent over network
- **Deterministic** - Same input always produces same output
- **Safe** - No arbitrary code execution on client
- **Analyzable** - Tools can reason about migrations

### Why Per-Document Versioning?

- **Non-blocking** - Users can work during migration
- **Resumable** - Crash recovery is trivial
- **Offline-friendly** - Each doc migrates independently
- **Observable** - Progress tracking per document

### Why Not Timestamps?

- **Clock skew** - Distributed systems have unreliable clocks
- **Non-atomic** - Multiple operations can share timestamp
- **Ordering** - Sequence numbers provide total order

---

## Future Work

- [ ] Migration dry-run mode for testing
- [ ] Rollback support (store previous version)
- [ ] Migration composition (combine multiple ops)
- [ ] Schema validation before/after migration
- [ ] Visual migration builder UI
- [ ] Migration performance metrics
