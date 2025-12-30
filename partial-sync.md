# Partial Sync Feature Plan

## Status: Future Enhancement

This feature is planned for a future phase. See `presence.md` for the current implementation focus.

## Overview

Currently, clients sync ALL documents in a collection. For large workspaces, this is inefficient - users typically only need a subset.

## Problem

- Large collections (1000s of documents) cause slow initial sync
- Users typically only work with a subset of documents
- Bandwidth and storage wasted on irrelevant documents

## Potential Approaches

### 1. Filtered Queries

Test if Convex query filters work efficiently with stream subscriptions.

### 2. Scope-Based Sync

Documents belong to scopes (teams, projects, users). Clients subscribe to their scopes only.

```typescript
// Each document belongs to scopes
const doc = {
  id: "doc_123",
  scope: ["team_abc", "user_xyz"],
};

// Client subscribes to their scopes
stream({ cursor, scope: ["team_abc", "user_xyz"] })
```

## Requirements

- Must work with existing CRDT sync protocol
- Must handle documents moving between scopes
- Must handle scope membership changes
- Recovery sync must still work correctly

## Open Questions

- How to handle documents that move between scopes?
- How to handle offline sync when scopes change?
- Index design for efficient scope-based queries?

## References

- [Linear Sync Engine](https://github.com/wzhudev/reverse-linear-sync-engine) - Uses sync groups pattern
